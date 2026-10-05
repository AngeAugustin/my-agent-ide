// Types et catalogue de la couche IA, partagés entre le processus principal et l'interface.

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'openai-compatible'

export interface ProviderDefinition {
  id: string
  name: string
  kind: ProviderKind
  description: string
  defaultBaseUrl: string
  /** L'URL de base peut être modifiée (proxy, serveur local sur un autre port…). */
  baseUrlEditable: boolean
  requiresKey: boolean
  /** Page où l'utilisateur obtient sa clé. */
  keyUrl?: string
  keyPlaceholder?: string
  /** Fournisseur exécuté sur la machine de l'utilisateur. */
  local?: boolean
  /** Accepte `stream_options.include_usage` (compteur de jetons en streaming). */
  streamUsage?: boolean
  /** Fournisseur d'embeddings uniquement (pas de conversation). */
  embeddingsOnly?: boolean
  /** Modèles connus d'avance (quand l'API ne permet pas de les lister). */
  staticModels?: ModelInfo[]
}

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    kind: 'anthropic',
    description: 'Modèles Claude : Opus, Sonnet, Haiku.',
    defaultBaseUrl: 'https://api.anthropic.com',
    baseUrlEditable: true,
    requiresKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    description: 'Modèles GPT et série o.',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: true,
    requiresKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    streamUsage: true
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'gemini',
    description: 'Modèles Gemini via Google AI Studio.',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: true,
    requiresKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    kind: 'openai-compatible',
    description: 'Mistral, Codestral, Devstral.',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    baseUrlEditable: false,
    requiresKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    streamUsage: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    description: 'DeepSeek Chat et Reasoner.',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrlEditable: false,
    requiresKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    streamUsage: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    description: 'Des centaines de modèles avec une seule clé.',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEditable: false,
    requiresKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-…',
    streamUsage: true
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    description: 'Inférence très rapide (Llama, Qwen…).',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    baseUrlEditable: false,
    requiresKey: true,
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…',
    streamUsage: true
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    kind: 'openai-compatible',
    description: 'Modèles Grok.',
    defaultBaseUrl: 'https://api.x.ai/v1',
    baseUrlEditable: false,
    requiresKey: true,
    keyUrl: 'https://console.x.ai',
    keyPlaceholder: 'xai-…',
    streamUsage: true
  },
  {
    id: 'voyage',
    name: 'Voyage AI (embeddings)',
    kind: 'openai-compatible',
    description: 'Embeddings spécialisés pour le code, recommandés par Anthropic.',
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    baseUrlEditable: false,
    requiresKey: true,
    keyUrl: 'https://dashboard.voyageai.com/',
    keyPlaceholder: 'pa-…',
    embeddingsOnly: true,
    staticModels: [
      { id: 'voyage-code-3', name: 'Voyage Code 3', kind: 'embedding' },
      { id: 'voyage-3.5', name: 'Voyage 3.5', kind: 'embedding' },
      { id: 'voyage-3.5-lite', name: 'Voyage 3.5 Lite', kind: 'embedding' }
    ]
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'openai-compatible',
    description: 'Modèles exécutés sur votre machine, sans clé.',
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseUrlEditable: true,
    requiresKey: false,
    local: true,
    streamUsage: true
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    kind: 'openai-compatible',
    description: 'Serveur local de LM Studio, sans clé.',
    defaultBaseUrl: 'http://localhost:1234/v1',
    baseUrlEditable: true,
    requiresKey: false,
    local: true
  }
]

/** Fournisseur ajouté par l'utilisateur (toute API compatible OpenAI). */
export interface CustomProvider {
  id: string
  name: string
  baseUrl: string
  requiresKey: boolean
}

export interface ModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxOutput?: number
  /** « embedding » : modèle de vectorisation (indexation du code) ; sinon modèle de conversation. */
  kind?: 'chat' | 'embedding'
}

export interface ModelRef {
  providerId: string
  modelId: string
}

export type ModelRole = 'chat' | 'edit' | 'autocomplete' | 'agent' | 'embeddings'

export const MODEL_ROLES: Array<{ id: ModelRole; label: string; description: string }> = [
  { id: 'chat', label: 'Chat', description: 'Conversation dans le panneau latéral (Ctrl+L).' },
  { id: 'edit', label: 'Édition en ligne', description: 'Modifications demandées avec Ctrl+K.' },
  { id: 'autocomplete', label: 'Autocomplétion', description: 'Suggestions pendant la frappe : privilégiez un modèle rapide (Codestral, DeepSeek, Haiku, un modèle de code local…).' },
  { id: 'agent', label: 'Agent', description: 'Tâches en plusieurs étapes sur plusieurs fichiers.' },
  {
    id: 'embeddings',
    label: 'Embeddings (indexation)',
    description: 'Recherche sémantique dans le code (@codebase). Optionnel : sans lui, la recherche reste locale par mots-clés.'
  }
]

export interface AiSettings {
  /** Réglages non secrets par fournisseur (les clés sont stockées à part, chiffrées). */
  providers: Record<string, { baseUrl?: string }>
  customProviders: CustomProvider[]
  models: Partial<Record<ModelRole, ModelRef>>
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  providers: {},
  customProviders: [],
  models: {}
}

export interface ProviderStatus {
  id: string
  name: string
  kind: ProviderKind
  description: string
  custom: boolean
  local: boolean
  requiresKey: boolean
  hasKey: boolean
  /** Clé masquée (ex. « sk-ant…x9Qz ») : la clé complète ne quitte jamais le processus principal. */
  maskedKey?: string
  baseUrl: string
  defaultBaseUrl: string
  baseUrlEditable: boolean
  keyUrl?: string
  keyPlaceholder?: string
  models: ModelInfo[]
  modelsFetchedAt?: number
}

export interface KeyStorageInfo {
  /** Vrai si les clés sont chiffrées par le trousseau du système. */
  encrypted: boolean
  backend: string
}

export interface ProviderTestResult {
  ok: boolean
  modelCount?: number
  error?: string
}

export interface UsageEntry {
  inputTokens: number
  outputTokens: number
  requests: number
  lastUsed: number
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; toolName: string; content: string; isError?: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
  /**
   * Contenu natif renvoyé par le fournisseur (blocs de réflexion, signatures…).
   * Il est renvoyé tel quel au même fournisseur pour que l'historique reste valide.
   */
  providerData?: { providerId: string; model: string; raw: unknown }
}

export interface ToolDefinition {
  name: string
  description: string
  /** Schéma JSON des paramètres. */
  inputSchema: Record<string, unknown>
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ChatRequest {
  providerId: string
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  maxTokens?: number
  /** Envoyé uniquement s'il est défini (certains modèles le refusent). */
  temperature?: number
  effort?: Effort
  /** Demande un résumé lisible de la réflexion du modèle, quand le fournisseur le permet. */
  showReasoning?: boolean
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
  /** Texte brut reçu quand les arguments ne sont pas du JSON valide : ne pas exécuter l'outil. */
  inputError?: string
}

export type StopReason = 'end' | 'max_tokens' | 'tool_use' | 'refusal' | 'other'

export type AiErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'not_found'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'aborted'
  | 'no_key'
  | 'unknown'

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'notice'; message: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /**
   * Fin de la réponse. Les appels d'outils ne doivent être exécutés que si
   * `stopReason` vaut « tool_use » (jamais après « max_tokens » ou « refusal »).
   */
  | { type: 'done'; stopReason: StopReason; message: ChatMessage; toolCalls: ToolCall[] }
  | { type: 'error'; code: AiErrorCode; message: string }

/** Message d'erreur affichable pour un arrêt inhabituel. */
export function stopReasonNotice(reason: StopReason): string | null {
  switch (reason) {
    case 'max_tokens':
      return 'La réponse a été coupée : la limite de longueur a été atteinte.'
    case 'refusal':
      return 'Le modèle a refusé de répondre à cette demande.'
    default:
      return null
  }
}

export function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
