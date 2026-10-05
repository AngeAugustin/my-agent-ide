// Prédiction de la prochaine modification : prompt, analyse de la réponse et choix du changement
// à proposer (partagé et testé).

import { diffLines } from './diff'

/** Une modification récente de l'utilisateur (lignes avant / après). */
export interface EditRecord {
  path: string
  /** Première ligne concernée (base 1, dans l'état actuel du fichier). */
  line: number
  before: string[]
  after: string[]
  at: number
}

/** Changement proposé dans la région : remplace `deleteCount` lignes à partir de `start` (base 0) par `insert`. */
export interface Hunk {
  start: number
  deleteCount: number
  insert: string[]
}

export const NEXT_EDIT_SYSTEM = [
  'Tu prédis la prochaine modification qu’un développeur va faire dans son code, d’après ses modifications récentes.',
  'Exemples : propager un renommage aux autres occurrences, adapter les appels après un changement de signature, compléter un motif répété, ajouter l’import ou le champ correspondant.',
  'On te donne ses dernières modifications puis une région du fichier ; le curseur y est marqué par <|CURSEUR|> (ce marqueur ne fait pas partie du code).',
  'Réponds UNIQUEMENT avec la région entière réécrite, modification appliquée, entre <region> et </region>, sans le marqueur du curseur et sans rien changer d’autre.',
  'Ne propose qu’une modification probable et cohérente avec les modifications récentes. Ne refais pas une modification déjà faite. Si rien d’évident ne suit, réponds exactement <aucune/>.'
].join('\n')

export const CURSOR = '<|CURSEUR|>'

/** Décrit les modifications récentes sous forme de mini-diffs. */
export function describeEdits(edits: EditRecord[]): string {
  return edits
    .map((e) => {
      const minus = e.before.map((l) => `-${l}`)
      const plus = e.after.map((l) => `+${l}`)
      return `--- ${e.path} (ligne ${e.line})\n${[...minus, ...plus].join('\n')}`
    })
    .join('\n\n')
}

export function nextEditPrompt(input: {
  path: string
  language: string
  edits: EditRecord[]
  regionLines: string[]
  /** Position du curseur dans la région (ligne base 0, colonne base 0). */
  cursor: { line: number; column: number }
}): string {
  const lines = [...input.regionLines]
  const l = lines[input.cursor.line] ?? ''
  lines[input.cursor.line] = l.slice(0, input.cursor.column) + CURSOR + l.slice(input.cursor.column)
  return [
    `Fichier : ${input.path} (langage : ${input.language})`,
    '',
    'Modifications récentes (de la plus ancienne à la plus récente) :',
    describeEdits(input.edits) || '(aucune)',
    '',
    'Région à réécrire :',
    '<region>',
    lines.join('\n'),
    '</region>'
  ].join('\n')
}

/** Extrait la région réécrite de la réponse du modèle (null : aucune modification proposée). */
export function parseNextEdit(raw: string): string[] | null {
  const text = raw.replace(/\r\n/g, '\n')
  if (/<aucune\s*\/?>/i.test(text) && !/<region>/i.test(text)) return null
  const m = /<region>\n?([\s\S]*?)\n?<\/region>/i.exec(text)
  if (!m) return null
  let body = m[1]
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(body)
  if (fence) body = fence[1]
  return body.split(CURSOR).join('').split('\n')
}

/** Changements entre la région d'origine et la proposition, regroupés en blocs contigus. */
export function computeHunks(original: string[], proposed: string[]): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const op of diffLines(original, proposed)) {
    if (op.type === 'equal') {
      current = null
      continue
    }
    const start = op.type === 'delete' ? op.oldStart : op.oldIndex
    if (!current || current.start + current.deleteCount !== start) {
      current = { start, deleteCount: 0, insert: [] }
      hunks.push(current)
    }
    if (op.type === 'delete') current.deleteCount += op.count
    else current.insert.push(...proposed.slice(op.newStart, op.newStart + op.count))
  }
  // Une ligne retirée puis remise à l'identique n'est pas un changement.
  return hunks.filter((h) => !(h.deleteCount === h.insert.length && h.insert.every((l, i) => l === original[h.start + i])))
}

/**
 * Choisit le changement à proposer : le plus proche du curseur, de préférence après lui.
 * Refuse une proposition qui réécrit une trop grande part de la région (réponse peu fiable).
 */
export function pickHunk(original: string[], hunks: Hunk[], cursorLine: number): Hunk | null {
  if (hunks.length === 0) return null
  const changed = hunks.reduce((n, h) => n + Math.max(h.deleteCount, h.insert.length), 0)
  if (changed > Math.max(8, original.length * 0.5)) return null
  const distance = (h: Hunk) => {
    const end = h.start + Math.max(h.deleteCount, 1) - 1
    if (cursorLine >= h.start && cursorLine <= end) return 0
    return h.start > cursorLine ? h.start - cursorLine : (cursorLine - end) * 1.5
  }
  return [...hunks].sort((a, b) => distance(a) - distance(b))[0]
}

/** Ajoute une modification à l'historique, en fusionnant la frappe continue sur les mêmes lignes. */
export function recordEdit(history: EditRecord[], edit: EditRecord, max = 6): EditRecord[] {
  const last = history[history.length - 1]
  if (
    last &&
    last.path === edit.path &&
    edit.at - last.at < 4000 &&
    edit.line >= last.line &&
    edit.line + edit.before.length <= last.line + last.after.length
  ) {
    // Frappe dans les lignes déjà modifiées : on remplace la partie concernée de « after ».
    const offset = edit.line - last.line
    const after = [...last.after.slice(0, offset), ...edit.after, ...last.after.slice(offset + edit.before.length)]
    const merged = { ...last, after, at: edit.at }
    const out = [...history.slice(0, -1)]
    if (merged.before.join('\n') !== merged.after.join('\n')) out.push(merged)
    return out
  }
  return [...history, edit].slice(-max)
}
