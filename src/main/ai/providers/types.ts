import type { ChatEvent, ChatRequest, ModelInfo, ProviderDefinition } from '@shared/ai'
import type { ErrorContext } from '../errors'

/** Configuration résolue pour un appel : définition, clé et URL effectives. */
export interface ProviderConfig {
  definition: ProviderDefinition
  apiKey: string | null
  baseUrl: string
  /** Remplace `fetch` (tests). */
  fetch?: typeof fetch
}

export interface ChatContext {
  emit: (event: ChatEvent) => void
  signal: AbortSignal
  /** Limite de sortie connue pour ce modèle (issue de la liste des modèles). */
  modelMaxOutput?: number
}

export interface ProviderAdapter {
  listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>
  /** Diffuse la réponse via `ctx.emit` et se termine par un événement « done » (ou lève une erreur). */
  chat(config: ProviderConfig, request: ChatRequest, ctx: ChatContext): Promise<void>
}

export function errorContext(config: ProviderConfig): ErrorContext {
  return { providerName: config.definition.name, baseUrl: config.baseUrl, local: config.definition.local }
}

/** Analyse stricte d'arguments JSON d'outil ; renvoie l'erreur au lieu de lever. */
export function parseToolInput(raw: string): { input: unknown; error?: string } {
  if (!raw.trim()) return { input: {} }
  try {
    return { input: JSON.parse(raw) }
  } catch {
    return { input: {}, error: raw }
  }
}
