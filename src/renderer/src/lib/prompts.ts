// Construction des prompts envoyés aux modèles.

export interface ResolvedContext {
  label: string
  /** Texte inséré dans le message (balisé). */
  text: string
  truncated?: boolean
}

const MAX_CONTEXT_CHARS = 120_000

/** Balise un fichier pour le prompt. */
export function fileBlock(path: string, content: string, lang = ''): ResolvedContext {
  let text = content
  let truncated = false
  if (text.length > MAX_CONTEXT_CHARS) {
    text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n[… fichier tronqué : ${content.length - MAX_CONTEXT_CHARS} caractères non inclus]`
    truncated = true
  }
  return { label: path, text: `<fichier chemin="${path}">\n\`\`\`${lang}\n${text}\n\`\`\`\n</fichier>`, truncated }
}

export function chatSystemPrompt(env: { os: string; workspace: string | null; activeFile: string | null }): string {
  return [
    'Tu es un assistant de programmation expert intégré à l’éditeur de code « My Agent IDE ».',
    'Réponds dans la langue de l’utilisateur (le français par défaut), de façon précise et concise.',
    `Système d’exploitation : ${env.os}.`,
    env.workspace ? `Dossier de travail ouvert : ${env.workspace}.` : 'Aucun dossier de travail n’est ouvert.',
    env.activeFile ? `Fichier actuellement ouvert dans l’éditeur : ${env.activeFile}.` : '',
    '',
    'Le contexte joint par l’utilisateur (fichiers, sélections, diagnostics, diff Git, sortie du terminal) est placé entre balises dans ses messages.',
    'Quand tu proposes du code destiné à un fichier, indique son chemin relatif après le langage dans la ligne d’ouverture du bloc, par exemple : ```ts:src/app.ts',
    'Pour modifier un fichier existant, donne de préférence le fichier complet ; si le fichier est long, donne seulement les parties modifiées en remplaçant le code inchangé par un commentaire « // ... code existant ... ».',
    'Pour les commandes à exécuter dans un terminal, utilise un bloc ```bash sans chemin.'
  ]
    .filter((l) => l !== null)
    .join('\n')
}

export function buildUserMessage(question: string, contexts: ResolvedContext[]): string {
  if (contexts.length === 0) return question
  return `${contexts.map((c) => c.text).join('\n\n')}\n\n${question}`
}

export const INLINE_EDIT_SYSTEM = [
  'Tu es un assistant de programmation intégré à un éditeur de code.',
  'Tu modifies le code selon l’instruction de l’utilisateur.',
  'Réponds UNIQUEMENT avec le code final dans un seul bloc de code Markdown, sans aucune explication avant ou après.',
  'Conserve l’indentation et le style du fichier. Ne recopie pas le code situé hors de la zone demandée.'
].join('\n')

export function inlineEditPrompt(opts: {
  path: string
  language: string
  before: string
  selection: string
  after: string
  instruction: string
  previousAttempt?: string
}): string {
  const target = opts.selection
    ? `Code sélectionné à réécrire :\n<selection>\n${opts.selection}\n</selection>`
    : 'Aucun code n’est sélectionné : écris le code à insérer à l’emplacement <curseur/>.'
  return [
    `Fichier : ${opts.path} (langage : ${opts.language})`,
    '',
    'Contexte du fichier :',
    '```' + opts.language,
    `${opts.before}${opts.selection ? '<selection>…</selection>' : '<curseur/>'}${opts.after}`,
    '```',
    '',
    target,
    opts.previousAttempt ? `\nTa proposition précédente était :\n\`\`\`\n${opts.previousAttempt}\n\`\`\`\nAméliore-la selon la nouvelle instruction.` : '',
    '',
    `Instruction : ${opts.instruction}`,
    '',
    opts.selection
      ? 'Renvoie uniquement le code qui remplace la sélection.'
      : 'Renvoie uniquement le code à insérer.'
  ].join('\n')
}

export const APPLY_SYSTEM = [
  'Tu appliques une modification proposée à un fichier existant.',
  'Renvoie le fichier COMPLET mis à jour dans un seul bloc de code Markdown, sans explication.',
  'Remplace les commentaires du type « ... code existant ... » par le code d’origine correspondant. Ne modifie rien d’autre.'
].join('\n')

export function applyPrompt(path: string, original: string, proposal: string): string {
  return [
    `Fichier : ${path}`,
    '',
    'Contenu actuel :',
    '```',
    original,
    '```',
    '',
    'Modification proposée :',
    '```',
    proposal,
    '```'
  ].join('\n')
}
