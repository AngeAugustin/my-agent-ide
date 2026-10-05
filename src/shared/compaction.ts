// Résumé des longues conversations (« compaction ») : quand l'historique approche de la limite
// du modèle, il est remplacé par un résumé produit par le modèle lui-même.

import type { ChatMessage } from './ai'

/** Résumé enregistré dans une conversation. */
export interface ConversationSummary {
  text: string
  /** Dernier tour couvert par le résumé (inclus). */
  turnId: string
  /** Pour un tour de l'agent : nombre d'étapes couvertes (les suivantes restent envoyées telles quelles). */
  stepCount: number
  createdAt: number
  /** Taille estimée de l'historique résumé, en jetons. */
  tokensBefore: number
}

export const COMPACTION_SYSTEM =
  'Tu résumes des conversations entre un utilisateur et un assistant de programmation, pour que l’assistant puisse poursuivre le travail sans l’historique complet.'

export const COMPACTION_INSTRUCTIONS = [
  'Rédige un résumé dense et factuel de la conversation ci-dessus, dans la langue de l’utilisateur. Il remplacera tout l’historique : n’omets rien d’utile pour continuer.',
  'Structure-le avec ces sections :',
  '1. Demandes de l’utilisateur : objectifs, contraintes et préférences exprimés (cite les consignes importantes mot pour mot).',
  '2. Travail effectué : fichiers lus, créés ou modifiés (chemins exacts) et nature des modifications, commandes lancées et leurs résultats.',
  '3. Connaissances acquises : structure du projet, fonctions et API pertinentes, erreurs rencontrées et leurs causes.',
  '4. État actuel : ce qui fonctionne, ce qui reste cassé ou incertain.',
  '5. Prochaines étapes : ce qu’il reste à faire pour terminer la demande en cours.',
  'Inclus les extraits de code indispensables (signatures, valeurs exactes). N’invente rien.'
].join('\n')

const TOOL_RESULT_MAX = 2500
const TEXT_MAX = 12_000

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  return `${text.slice(0, head)}\n[… ${text.length - max} caractères omis …]\n${text.slice(-(max - head))}`
}

/** Transcription textuelle de l'historique, indépendante du fournisseur (pas de blocs natifs). */
export function transcriptForSummary(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const who = m.role === 'user' ? 'UTILISATEUR' : 'ASSISTANT'
    if (typeof m.content === 'string') {
      lines.push(`### ${who}\n${clipMiddle(m.content, TEXT_MAX)}`)
      continue
    }
    const parts: string[] = []
    for (const p of m.content) {
      if (p.type === 'text') parts.push(clipMiddle(p.text, TEXT_MAX))
      else if (p.type === 'image') parts.push('[image jointe]')
      else if (p.type === 'tool_call') parts.push(`[appel d’outil ${p.name}] ${clipMiddle(JSON.stringify(p.input), 4000)}`)
      else parts.push(`[résultat de ${p.toolName}${p.isError ? ' (erreur)' : ''}]\n${clipMiddle(p.content, TOOL_RESULT_MAX)}`)
    }
    const role = m.content.every((p) => p.type === 'tool_result') ? 'RÉSULTATS D’OUTILS' : who
    lines.push(`### ${role}\n${parts.join('\n')}`)
  }
  return lines.join('\n\n')
}

/** Message unique demandant le résumé. */
export function compactionRequest(messages: ChatMessage[], previousSummary?: string): ChatMessage[] {
  const before = previousSummary ? `<resume_precedent>\n${previousSummary}\n</resume_precedent>\n\n` : ''
  return [{ role: 'user', content: `${before}<conversation>\n${transcriptForSummary(messages)}\n</conversation>\n\n${COMPACTION_INSTRUCTIONS}` }]
}

/** Texte placé en tête de l'historique à la place des échanges résumés. */
export function summaryPreamble(summary: string): string {
  return `<resume_de_la_conversation>\nLes échanges précédents ont été résumés pour libérer de la place :\n\n${summary}\n</resume_de_la_conversation>`
}

/** Estimation grossière du nombre de jetons (environ 4 caractères par jeton). */
export function estimateTokens(messages: ChatMessage[], system = ''): number {
  let chars = system.length
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else
      for (const p of m.content) {
        if (p.type === 'text') chars += p.text.length
        else if (p.type === 'image') chars += 6000
        else if (p.type === 'tool_call') chars += JSON.stringify(p.input ?? null).length + p.name.length
        else chars += p.content.length
      }
  }
  return Math.ceil(chars / 4)
}

/** Fenêtre de contexte d'un modèle (connue par l'API, sinon estimation prudente). */
export function contextWindowFor(modelId: string, known?: number): number {
  if (known && known > 0) return known
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return 200_000
  if (id.includes('gemini')) return 1_000_000
  if (/gpt-4\.1|gpt-5/.test(id)) return 400_000
  if (/gpt-4o|o[134]/.test(id)) return 128_000
  return 32_000
}

export function shouldCompact(usedTokens: number, contextWindow: number, threshold: number): boolean {
  const t = Math.min(Math.max(threshold, 0.5), 0.95)
  return usedTokens > contextWindow * t
}

/** Préfixe le premier message utilisateur par le résumé (les messages doivent commencer par l'utilisateur). */
export function prependToUser(message: ChatMessage, prefix: string): ChatMessage {
  if (typeof message.content === 'string') return { ...message, content: `${prefix}\n\n${message.content}` }
  return { ...message, content: [{ type: 'text', text: prefix }, ...message.content] }
}
