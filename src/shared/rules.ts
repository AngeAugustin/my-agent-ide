// Règles de projet (« .cursorrules », « .cursor/rules/*.mdc », « AGENTS.md »…) : analyse et sélection.

export interface ProjectRule {
  /** Fichier d'origine, relatif au projet. */
  source: string
  content: string
  description?: string
  /** Motifs de fichiers : la règle s'applique quand un fichier concerné correspond. */
  globs: string[]
  /** Toujours incluse. */
  alwaysApply: boolean
}

/** Fichiers de règles reconnus à la racine du projet (dans l'ordre de priorité). */
export const ROOT_RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md', '.ide/rules.md']

/** Dossiers contenant un fichier de règle par sujet (format .mdc de Cursor ou Markdown). */
export const RULE_DIRS = ['.cursor/rules', '.ide/rules']

const MAX_RULE_CHARS = 20_000

function parseList(value: string): string[] {
  const v = value.trim()
  if (!v) return []
  if (v.startsWith('[')) {
    try {
      const arr = JSON.parse(v)
      if (Array.isArray(arr)) return arr.map(String).map((s) => s.trim()).filter(Boolean)
    } catch {
      // format non JSON : on découpe à la main
    }
    return v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  return v.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

/** Analyse un fichier de règle ; l'en-tête facultatif (--- … ---) donne description, globs et alwaysApply. */
export function parseRule(source: string, raw: string): ProjectRule {
  const text = raw.replace(/\r\n/g, '\n')
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  let body = text
  let description: string | undefined
  let globs: string[] = []
  let alwaysApply: boolean | undefined
  if (match) {
    body = text.slice(match[0].length)
    for (const line of match[1].split('\n')) {
      const m = line.match(/^(\w+)\s*:\s*(.*)$/)
      if (!m) continue
      const [, key, value] = m
      if (key === 'description') description = value.trim().replace(/^["']|["']$/g, '') || undefined
      else if (key === 'globs') globs = parseList(value)
      else if (key === 'alwaysApply') alwaysApply = /^true$/i.test(value.trim())
    }
  }
  // Sans en-tête (ou fichier racine comme AGENTS.md), la règle s'applique toujours.
  const isRootFile = !source.includes('/rules/')
  return {
    source,
    content: body.trim().slice(0, MAX_RULE_CHARS),
    description,
    globs,
    alwaysApply: alwaysApply ?? (isRootFile || (!match && globs.length === 0))
  }
}

/** Convertit un motif glob (« src/**\/*.ts », « *.{js,jsx} ») en expression régulière sur un chemin relatif. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  const g = glob.trim().replace(/^\.\//, '')
  while (i < g.length) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // « **/ » : zéro ou plusieurs dossiers.
        if (g[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
        continue
      }
      re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end > i) {
        re += `(?:${g
          .slice(i + 1, end)
          .split(',')
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&'))
          .join('|')})`
        i = end + 1
        continue
      }
      re += '\\{'
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
    i++
  }
  // Un motif sans « / » s'applique au nom de fichier, où qu'il soit.
  return new RegExp(g.includes('/') ? `^${re}$` : `(^|/)${re}$`)
}

/** Règles à appliquer pour un ensemble de fichiers concernés (fichier actif, contexte…). */
export function selectRules(rules: ProjectRule[], files: string[]): { applied: ProjectRule[]; available: ProjectRule[] } {
  const applied: ProjectRule[] = []
  const available: ProjectRule[] = []
  for (const rule of rules) {
    if (!rule.content) continue
    if (rule.alwaysApply) applied.push(rule)
    else if (rule.globs.length && files.some((f) => rule.globs.some((g) => globToRegExp(g).test(f)))) applied.push(rule)
    else if (rule.description) available.push(rule)
  }
  return { applied, available }
}

/** Section de prompt système décrivant les règles. */
export function rulesPrompt(userRules: string, applied: ProjectRule[], available: ProjectRule[] = []): string {
  const parts: string[] = []
  if (userRules.trim()) parts.push(`Règles de l’utilisateur (à respecter) :\n${userRules.trim()}`)
  for (const r of applied) parts.push(`Règles du projet (${r.source}) :\n${r.content}`)
  if (available.length) {
    parts.push(
      `Autres règles disponibles (lis le fichier si elles concernent la tâche) :\n${available.map((r) => `- ${r.source} : ${r.description}`).join('\n')}`
    )
  }
  return parts.length ? `\n\n<regles>\n${parts.join('\n\n')}\n</regles>` : ''
}
