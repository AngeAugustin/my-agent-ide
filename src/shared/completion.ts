// Autocomplétion : requête, prompt et nettoyage des suggestions (partagé et testé).

export interface CompletionRequest {
  providerId: string
  model: string
  /** Chemin relatif du fichier (contexte pour le modèle). */
  path: string
  language: string
  /** Texte avant le curseur. */
  prefix: string
  /** Texte après le curseur. */
  suffix: string
  maxTokens?: number
}

export interface CompletionResult {
  text: string
  /** « fim » : point d'API dédié au remplissage ; « chat » : modèle conversationnel. */
  via: 'fim' | 'chat'
}

export const CURSOR_MARKER = '<|CURSEUR|>'

export const COMPLETION_SYSTEM = [
  'Tu es un moteur d’autocomplétion de code intégré à un éditeur.',
  `On te donne un fichier où la position du curseur est marquée par ${CURSOR_MARKER}.`,
  'Réponds UNIQUEMENT avec le texte à insérer exactement à cette position : pas de bloc Markdown, pas d’explication, ne répète pas le code déjà présent avant ou après le curseur.',
  'Complète au plus quelques lignes cohérentes (la fin de l’instruction, du bloc ou de la fonction en cours).',
  'Si aucune complétion n’est utile, réponds par une chaîne vide.'
].join('\n')

export function completionUserPrompt(req: Pick<CompletionRequest, 'path' | 'language' | 'prefix' | 'suffix'>): string {
  return `Fichier : ${req.path} (langage : ${req.language})\n\n${req.prefix}${CURSOR_MARKER}${req.suffix}`
}

const MAX_LINES = 30

/**
 * Nettoie la réponse brute d'un modèle pour l'insérer au curseur :
 * retire les blocs Markdown, le marqueur, la répétition de la ligne courante
 * et le texte qui existe déjà juste après le curseur.
 */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/\r\n/g, '\n')

  // Bloc Markdown englobant.
  const fence = text.match(/^\s*```[^\n]*\n([\s\S]*?)(\n```\s*)?$/)
  if (fence) text = fence[1]
  text = text.split(CURSOR_MARKER).join('')

  // Le modèle recopie parfois la ligne en cours : on retire la partie déjà tapée.
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  const typed = currentLine.trimStart()
  // Seuil de 3 caractères : en dessous, une vraie suite peut commencer par les mêmes lettres.
  if (typed.length >= 3 && text.trimStart().startsWith(typed)) {
    const candidate = text.trimStart().slice(typed.length)
    if (candidate.trim()) text = candidate
  }

  // Plusieurs lignes : on limite la longueur.
  const lines = text.split('\n')
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join('\n')

  text = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')

  // Retire ce qui existe déjà après le curseur sur la même ligne (ex. « ) » ou « ; » fermants).
  const restOfLine = suffix.split('\n')[0]
  if (restOfLine.trim()) {
    const rest = restOfLine.trim()
    const firstLine = text.split('\n')[0]
    if (!text.includes('\n') && firstLine.endsWith(rest)) text = text.slice(0, text.length - rest.length)
  }

  // Le texte déjà présent sur les lignes suivantes ne doit pas être répété.
  const nextLines = suffix.replace(/^[^\n]*\n?/, '').split('\n').filter((l) => l.trim()).slice(0, 3)
  if (nextLines.length && text.includes('\n')) {
    const out = text.split('\n')
    const idx = out.findIndex((l, i) => i > 0 && l.trim() === nextLines[0].trim())
    if (idx > 0) text = out.slice(0, idx).join('\n').replace(/\n+$/, '')
  }

  return text.trim() ? text : ''
}

/** Indique si la suite de la ligne permet une complétion (vide ou seulement des fermetures). */
export function canCompleteBefore(restOfLine: string): boolean {
  return /^[\s)\]}>"'`;,]*$/.test(restOfLine)
}

export interface CompletionCacheEntry {
  prefix: string
  suffix: string
  text: string
}

/** Cherche une suggestion déjà obtenue dont l'utilisateur a tapé le début : renvoie la partie restante. */
export function lookupCompletionCache(prefix: string, suffix: string, entries: CompletionCacheEntry[]): string | null {
  for (const e of entries) {
    if (!prefix.startsWith(e.prefix)) continue
    const typed = prefix.slice(e.prefix.length)
    if (typed.length > e.text.length || !e.text.startsWith(typed)) continue
    const rest = e.text.slice(typed.length)
    if (!rest) continue
    if (suffix === e.suffix) return rest

    // L'éditeur a pu fermer automatiquement une parenthèse ou un guillemet (« add( » devient « add() ») :
    // on propose alors la suggestion jusqu'à ce caractère fermant, qui est déjà présent.
    const closers = suffix.match(/^[)\]}'"`]+/)?.[0]
    if (closers && e.suffix.startsWith(suffix.slice(closers.length, closers.length + 200))) {
      const idx = rest.indexOf(closers)
      if (idx > 0) return rest.slice(0, idx)
    }
  }
  return null
}
