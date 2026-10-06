import { useChat, type AssistantTurn, type Conversation, type UserTurn } from './chat'

export interface PlanFile {
  path: string
  /** Contenu avant la première modification de l'agent (null : fichier créé par l'agent). */
  original: string | null
}

/** Conversation en Mode Agent affichée par la vue Plan : l'active, sinon la plus récente. */
export function planConversation(state: { conversations: Conversation[]; activeId: string | null } = useChat.getState()): Conversation | undefined {
  const hasAgentWork = (c: Conversation) => c.turns.some((t) => t.role === 'assistant' && !!t.steps)
  const active = state.conversations.find((c) => c.id === state.activeId)
  if (active && hasAgentWork(active)) return active
  return [...state.conversations].filter(hasAgentWork).sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Fichiers modifiés par l'agent (points de restauration non annulés), avec leur état d'origine. */
export function planFiles(conv: Conversation | undefined): PlanFile[] {
  const files = new Map<string, string | null>()
  for (const t of conv?.turns ?? []) {
    if (t.role !== 'user') continue
    const cp = (t as UserTurn).checkpoint
    if (!cp || cp.restored) continue
    for (const [path, original] of Object.entries(cp.files)) if (!files.has(path)) files.set(path, original)
  }
  return [...files.entries()].map(([path, original]) => ({ path, original }))
}

/** Étapes de l'agent (pour le journal d'exécution). */
export function planTurns(conv: Conversation | undefined): AssistantTurn[] {
  return (conv?.turns ?? []).filter((t): t is AssistantTurn => t.role === 'assistant' && !!t.steps)
}

export function usePlanCount(): number {
  return useChat((s) => planFiles(planConversation(s)).length)
}
