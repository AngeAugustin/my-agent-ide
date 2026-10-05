import { create } from 'zustand'
import type { KeyStorageInfo, ModelRef, ModelRole, ProviderStatus, UsageEntry } from '@shared/ai'
import { updateSettings, useIde } from './ide'

interface AiState {
  loaded: boolean
  providers: ProviderStatus[]
  storage: KeyStorageInfo | null
  usage: Record<string, UsageEntry>
}

export const useAi = create<AiState>()(() => ({ loaded: false, providers: [], storage: null, usage: {} }))

/** Modèles proposés par défaut quand un fournisseur vient d'être configuré. */
const DEFAULT_MODELS: Record<string, Partial<Record<ModelRole, string>>> = {
  anthropic: { chat: 'claude-opus-5-5', edit: 'claude-opus-5-5', agent: 'claude-opus-5-5', autocomplete: 'claude-haiku-4-5' },
  voyage: { embeddings: 'voyage-code-3' },
  openai: { embeddings: 'text-embedding-3-small' },
  gemini: { embeddings: 'gemini-embedding-001' },
  mistral: { embeddings: 'codestral-embed' }
}

export async function loadAi(): Promise<void> {
  const [{ providers, storage }, usage] = await Promise.all([window.api.ai.providers(), window.api.ai.usage()])
  useAi.setState({ loaded: true, providers, storage, usage })
}

export function providerName(id: string): string {
  return useAi.getState().providers.find((p) => p.id === id)?.name ?? id
}

/**
 * Fournisseurs utilisables : clé présente (ou non requise), avec seulement les modèles
 * du type demandé (conversation par défaut, ou embeddings).
 */
export function readyProviders(kind: 'chat' | 'embedding' = 'chat'): ProviderStatus[] {
  return useAi
    .getState()
    .providers.filter((p) => p.hasKey || !p.requiresKey)
    .map((p) => ({ ...p, models: p.models.filter((m) => (kind === 'embedding' ? m.kind === 'embedding' : m.kind !== 'embedding')) }))
    .filter((p) => p.models.length > 0)
}

export function setModelForRole(role: ModelRole, ref: ModelRef | undefined): void {
  const ai = useIde.getState().settings.ai
  const models = { ...ai.models }
  if (ref) models[role] = ref
  else delete models[role]
  void updateSettings({ ai: { ...ai, models } }).then(() => {
    if (role === 'embeddings') void window.api.index.settingsChanged()
  })
}

/** Après la configuration d'un fournisseur, remplit les rôles encore vides avec ses modèles par défaut. */
export function applyDefaultModels(providerId: string): void {
  const provider = useAi.getState().providers.find((p) => p.id === providerId)
  const defaults = DEFAULT_MODELS[providerId]
  if (!provider || !defaults) return
  const ai = useIde.getState().settings.ai
  const models = { ...ai.models }
  let changed = false
  for (const [role, modelId] of Object.entries(defaults) as Array<[ModelRole, string]>) {
    if (!models[role] && provider.models.some((m) => m.id === modelId)) {
      models[role] = { providerId, modelId }
      changed = true
    }
  }
  if (changed) void updateSettings({ ai: { ...ai, models } }).then(() => window.api.index.settingsChanged())
}

export function modelLabel(ref: ModelRef | undefined): string {
  if (!ref) return 'Aucun modèle'
  const provider = useAi.getState().providers.find((p) => p.id === ref.providerId)
  const model = provider?.models.find((m) => m.id === ref.modelId)
  return model?.name ?? ref.modelId
}
