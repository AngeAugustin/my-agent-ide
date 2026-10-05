import type { ChatMessage, ContentPart, ToolCall } from '@shared/ai'

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
