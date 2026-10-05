import type { ChatMessage, ModelRef } from '@shared/ai'
import { COMPACTION_SYSTEM, compactionRequest, contextWindowFor, estimateTokens, shouldCompact } from '@shared/compaction'
import { useAi } from '../store/ai'
import { useIde } from '../store/ide'
import { streamChat, type ChatHandle } from './ai'

/** Fenêtre de contexte du modèle (liste des modèles du fournisseur, sinon estimation). */
export function contextWindow(ref: ModelRef): number {
  const known = useAi.getState().providers.find((p) => p.id === ref.providerId)?.models.find((m) => m.id === ref.modelId)?.contextWindow
  return contextWindowFor(ref.modelId, known)
}

/** Vrai si l'historique doit être résumé avant la prochaine requête. */
export function needsCompaction(ref: ModelRef, messages: ChatMessage[], system: string, reportedTokens = 0): boolean {
  const s = useIde.getState().settings
  if (!s.autoCompact) return false
  return shouldCompact(Math.max(reportedTokens, estimateTokens(messages, system)), contextWindow(ref), s.compactThreshold)
}

/** Demande au modèle un résumé de l'historique. `onHandle` permet d'interrompre la requête. */
export async function summarizeHistory(
  ref: ModelRef,
  messages: ChatMessage[],
  onHandle?: (h: ChatHandle | null) => void
): Promise<{ ok: true; text: string } | { ok: false; message: string; aborted: boolean }> {
  const handle = streamChat({
    providerId: ref.providerId,
    model: ref.modelId,
    system: COMPACTION_SYSTEM,
    messages: compactionRequest(messages),
    maxTokens: 8000
  })
  onHandle?.(handle)
  const result = await handle.result
  onHandle?.(null)
  if (!result.ok) return { ok: false, message: result.message, aborted: result.code === 'aborted' }
  if (!result.text.trim()) return { ok: false, message: 'Le modèle a renvoyé un résumé vide.', aborted: false }
  return { ok: true, text: result.text.trim() }
}
