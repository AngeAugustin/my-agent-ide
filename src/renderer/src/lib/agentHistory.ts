import type { ChatMessage, ContentPart, ToolCall } from '@shared/ai'
import { prependToUser, summaryPreamble, type ConversationSummary } from '@shared/compaction'

/** Résumé affiché dans l'interface pour un appel d'outil. */
export interface ToolSummary {
  path?: string
  added?: number
  removed?: number
  command?: string
  exitCode?: number | null
}

export type ToolRunStatus = 'pending' | 'approval' | 'running' | 'done' | 'error' | 'denied' | 'skipped'

export interface AgentToolRun {
  call: ToolCall
  status: ToolRunStatus
  output?: string
  isError?: boolean
  summary?: ToolSummary
  /** Sortie en direct d'une commande en cours. */
  live?: string
}

/** Une étape de l'agent : une réponse du modèle et les outils qu'il a appelés. */
export interface AgentStep {
  id: string
  text: string
  reasoning: string
  tools: AgentToolRun[]
  /** Contenu natif de la réponse (présent seulement si l'étape s'est terminée normalement). */
  providerData?: ChatMessage['providerData']
}


/**
 * Étapes de l'agent → messages : chaque réponse du modèle est suivie d'un message contenant
 * TOUS les résultats de ses appels d'outils (un appel resté sans résultat reçoit une erreur).
 */
export function agentStepMessages(steps: AgentStep[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const step of steps) {
    const parts: ContentPart[] = []
    if (step.text) parts.push({ type: 'text', text: step.text })
    for (const t of step.tools) parts.push({ type: 'tool_call', id: t.call.id, name: t.call.name, input: t.call.input })
    if (parts.length === 0) continue
    out.push({ role: 'assistant', content: parts, ...(step.providerData ? { providerData: step.providerData } : {}) })
    if (step.tools.length > 0) {
      out.push({
        role: 'user',
        content: step.tools.map((t) => ({
          type: 'tool_result' as const,
          toolCallId: t.call.id,
          toolName: t.call.name,
          content: t.output ?? 'Exécution interrompue par l’utilisateur.',
          isError: t.output === undefined ? true : !!t.isError
        }))
      })
    }
  }
  return out
}

/** Forme minimale des tours de conversation utilisée pour reconstituer l'historique. */
export type HistoryTurn =
  | { id: string; role: 'user'; sent: string; images: Array<{ mediaType: string; data: string }> }
  | { id: string; role: 'assistant'; text: string; status: string; providerData?: ChatMessage['providerData']; steps?: AgentStep[] }

/**
 * Reconstitue l'historique envoyé au modèle (tours terminés uniquement, contenu inchangé).
 * Avec un résumé, les tours qu'il couvre sont remplacés par son texte, placé en tête du premier message utilisateur.
 */
export function toApiMessages(turns: HistoryTurn[], summary?: ConversationSummary): ChatMessage[] {
  const out: ChatMessage[] = []
  let start = 0
  let prefix: string | null = null
  if (summary) {
    const idx = turns.findIndex((t) => t.id === summary.turnId)
    if (idx >= 0) {
      start = idx + 1
      prefix = summaryPreamble(summary.text)
      const t = turns[idx]
      const rest = t.role === 'assistant' && t.steps ? t.steps.slice(summary.stepCount) : []
      if (rest.length) {
        // Étapes de l'agent postérieures au résumé (résumé effectué en cours de tâche).
        out.push({ role: 'user', content: prefix })
        prefix = null
        out.push(...agentStepMessages(rest))
      }
    }
  }
  for (const t of turns.slice(start)) {
    if (t.role === 'user') {
      const content: ContentPart[] | string = t.images.length
        ? [{ type: 'text', text: t.sent }, ...t.images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data }))]
        : t.sent
      out.push(prefix ? prependToUser({ role: 'user', content }, prefix) : { role: 'user', content })
      prefix = null
    } else if (t.steps) {
      out.push(...agentStepMessages(t.steps))
    } else if (t.text || t.providerData) {
      // Une réponse interrompue n'a pas de contenu natif complet : on n'en garde que le texte.
      out.push({ role: 'assistant', content: t.text, ...(t.status === 'done' && t.providerData ? { providerData: t.providerData } : {}) })
    }
  }
  if (prefix) out.push({ role: 'user', content: prefix })
  return out
}

