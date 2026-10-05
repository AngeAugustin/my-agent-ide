import {
  BUILTIN_PROVIDERS,
  DEFAULT_AI_SETTINGS,
  type AiSettings,
  type ChatEvent,
  type ChatRequest,
  type KeyStorageInfo,
  type ModelInfo,
  type ProviderDefinition,
  type ProviderStatus,
  type ProviderTestResult,
  type UsageEntry
} from '@shared/ai'
import { AiError, toAiError } from './errors'
import type { KeyStore } from './keyStore'
import { anthropicAdapter } from './providers/anthropic'
import { geminiAdapter } from './providers/gemini'
import { openAiAdapter } from './providers/openai'
import type { ProviderAdapter, ProviderConfig } from './providers/types'

export interface Persisted<T> {
  get(): Promise<T>
  set(value: T): Promise<void>
}

export type ModelCache = Record<string, { models: ModelInfo[]; fetchedAt: number }>
export type UsageStats = Record<string, UsageEntry>

export interface AiServiceOptions {
  keys: KeyStore
  getSettings: () => Promise<AiSettings | undefined>
  modelCache: Persisted<ModelCache>
  usage: Persisted<UsageStats>
  storageInfo: () => KeyStorageInfo
  fetch?: typeof fetch
}

const ADAPTERS: Record<ProviderDefinition['kind'], ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openAiAdapter,
  'openai-compatible': openAiAdapter,
  gemini: geminiAdapter
}

export function isValidBaseUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Orchestration des fournisseurs : résolution des clés et URL, liste des modèles, conversation en flux. */
export class AiService {
  constructor(private readonly opts: AiServiceOptions) {}

  private async settings(): Promise<AiSettings> {
    return { ...DEFAULT_AI_SETTINGS, ...(await this.opts.getSettings()) }
  }

  private definitions(settings: AiSettings): ProviderDefinition[] {
    const custom = settings.customProviders.map(
      (c): ProviderDefinition => ({
        id: c.id,
        name: c.name,
        kind: 'openai-compatible',
        description: 'Fournisseur personnalisé compatible OpenAI.',
        defaultBaseUrl: c.baseUrl,
        baseUrlEditable: false,
        requiresKey: c.requiresKey,
        local: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(c.baseUrl)
      })
    )
    return [...BUILTIN_PROVIDERS, ...custom]
  }

  private async definition(providerId: string): Promise<{ def: ProviderDefinition; settings: AiSettings }> {
    const settings = await this.settings()
    const def = this.definitions(settings).find((d) => d.id === providerId)
    if (!def) throw new AiError('not_found', `Fournisseur inconnu : « ${providerId} ».`)
    return { def, settings }
  }

  async resolve(providerId: string): Promise<ProviderConfig> {
    const { def, settings } = await this.definition(providerId)
    const override = def.baseUrlEditable ? settings.providers[def.id]?.baseUrl?.trim() : undefined
    const baseUrl = (override && isValidBaseUrl(override) ? override : def.defaultBaseUrl).replace(/\/+$/, '')
    const apiKey = await this.opts.keys.get(def.id)
    if (def.requiresKey && !apiKey) {
      throw new AiError('no_key', `Aucune clé API n'est configurée pour ${def.name}. Ajoutez-la dans Paramètres › Modèles et clés API.`)
    }
    return { definition: def, apiKey, baseUrl, fetch: this.opts.fetch }
  }

  async statuses(): Promise<{ providers: ProviderStatus[]; storage: KeyStorageInfo }> {
    const settings = await this.settings()
    const keys = await this.opts.keys.list()
    const cache = await this.opts.modelCache.get()
    const providers = this.definitions(settings).map((def): ProviderStatus => {
      const override = def.baseUrlEditable ? settings.providers[def.id]?.baseUrl : undefined
      return {
        id: def.id,
        name: def.name,
        kind: def.kind,
        description: def.description,
        custom: !BUILTIN_PROVIDERS.some((b) => b.id === def.id),
        local: !!def.local,
        requiresKey: def.requiresKey,
        hasKey: !!keys[def.id],
        maskedKey: keys[def.id]?.masked,
        baseUrl: override || def.defaultBaseUrl,
        defaultBaseUrl: def.defaultBaseUrl,
        baseUrlEditable: def.baseUrlEditable,
        keyUrl: def.keyUrl,
        keyPlaceholder: def.keyPlaceholder,
        models: cache[def.id]?.models ?? [],
        modelsFetchedAt: cache[def.id]?.fetchedAt
      }
    })
    return { providers, storage: this.opts.storageInfo() }
  }

  async setKey(providerId: string, key: string): Promise<void> {
    await this.definition(providerId)
    await this.opts.keys.set(providerId, key)
  }

  async deleteKey(providerId: string): Promise<void> {
    await this.opts.keys.delete(providerId)
    const cache = await this.opts.modelCache.get()
    if (cache[providerId]) {
      delete cache[providerId]
      await this.opts.modelCache.set(cache)
    }
  }

  async models(providerId: string, refresh = false): Promise<ModelInfo[]> {
    const cache = await this.opts.modelCache.get()
    if (!refresh && cache[providerId]) return cache[providerId].models
    const config = await this.resolve(providerId)
    const models = await ADAPTERS[config.definition.kind].listModels(config, AbortSignal.timeout(20_000))
    await this.opts.modelCache.set({ ...(await this.opts.modelCache.get()), [providerId]: { models, fetchedAt: Date.now() } })
    return models
  }

  /** Vérifie la clé et l'URL en récupérant la liste des modèles. */
  async test(providerId: string): Promise<ProviderTestResult> {
    try {
      const models = await this.models(providerId, true)
      return { ok: true, modelCount: models.length }
    } catch (err) {
      const { def } = await this.definition(providerId).catch(() => ({ def: undefined }))
      return { ok: false, error: toAiError(err, { providerName: def?.name ?? providerId, baseUrl: '' }).message }
    }
  }

  /** Lance une conversation en flux. Ne lève jamais : les erreurs sont émises comme événements. */
  async chat(request: ChatRequest, emit: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
    let config: ProviderConfig | undefined
    let usage = { inputTokens: 0, outputTokens: 0 }
    try {
      config = await this.resolve(request.providerId)
      const cache = await this.opts.modelCache.get()
      const modelMaxOutput = cache[request.providerId]?.models.find((m) => m.id === request.model)?.maxOutput
      await ADAPTERS[config.definition.kind].chat(config, request, {
        signal,
        modelMaxOutput,
        emit: (event) => {
          if (event.type === 'usage') usage = event
          emit(event)
        }
      })
    } catch (err) {
      const e = toAiError(err, {
        providerName: config?.definition.name ?? request.providerId,
        baseUrl: config?.baseUrl ?? '',
        local: config?.definition.local
      })
      emit({ type: 'error', code: e.code, message: e.message })
    } finally {
      if (config) await this.recordUsage(request.providerId, usage.inputTokens, usage.outputTokens)
    }
  }

  private async recordUsage(providerId: string, inputTokens: number, outputTokens: number): Promise<void> {
    const stats = await this.opts.usage.get()
    const prev = stats[providerId] ?? { inputTokens: 0, outputTokens: 0, requests: 0, lastUsed: 0 }
    stats[providerId] = {
      inputTokens: prev.inputTokens + inputTokens,
      outputTokens: prev.outputTokens + outputTokens,
      requests: prev.requests + 1,
      lastUsed: Date.now()
    }
    await this.opts.usage.set(stats)
  }

  async usage(): Promise<UsageStats> {
    return this.opts.usage.get()
  }

  async resetUsage(): Promise<void> {
    await this.opts.usage.set({})
  }
}
