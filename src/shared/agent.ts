// Mode Agent : outils, règles de sécurité et réglages (partagé et testé).

import type { ToolDefinition } from './ai'

export type CommandPolicy = 'allowlist' | 'always'

export interface AgentSettings {
  /** « allowlist » : seules les commandes listées s'exécutent sans demander (liste vide = toujours demander) ; « always » : aucune confirmation. */
  commandPolicy: CommandPolicy
  /** Commandes autorisées sans confirmation (préfixes exacts). */
  allowlist: string[]
  /** Nombre maximal d'étapes (appels au modèle) par demande. */
  maxSteps: number
  /** Délai maximal d'une commande, en secondes. */
  commandTimeout: number
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  commandPolicy: 'allowlist',
  allowlist: ['ls', 'pwd', 'cat', 'git status', 'git diff', 'git log', 'node --version', 'npm --version'],
  maxSteps: 25,
  commandTimeout: 120
}

export type ToolName =
  | 'list_dir'
  | 'read_file'
  | 'search_text'
  | 'find_files'
  | 'edit_file'
  | 'write_file'
  | 'delete_file'
  | 'run_command'
  | 'get_problems'

export const AGENT_TOOLS: Array<ToolDefinition & { name: ToolName }> = [
  {
    name: 'list_dir',
    description: 'Liste le contenu d’un dossier du projet (les dossiers se terminent par « / »).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin relatif à la racine du projet (« . » pour la racine).' },
        recursive: { type: 'boolean', description: 'Inclure les sous-dossiers (limité à 500 entrées).' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_file',
    description:
      'Lit un fichier texte du projet. Chaque ligne est préfixée par son numéro. Pour un gros fichier, lis-le par plages de lignes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin relatif à la racine du projet.' },
        start_line: { type: 'integer', description: 'Première ligne (base 1, optionnelle).' },
        end_line: { type: 'integer', description: 'Dernière ligne incluse (optionnelle).' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_text',
    description: 'Recherche un texte ou une expression régulière dans les fichiers du projet. Renvoie fichier:ligne: extrait.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texte ou expression régulière à chercher.' },
        regex: { type: 'boolean', description: 'Interpréter la requête comme une expression régulière.' },
        case_sensitive: { type: 'boolean' },
        include: { type: 'string', description: 'Filtre de fichiers, ex. « *.ts, src/** ».' }
      },
      required: ['query']
    }
  },
  {
    name: 'find_files',
    description: 'Trouve des fichiers par nom ou par motif (ex. « *.test.ts », « config »).',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Partie du nom ou motif avec « * ».' } },
      required: ['pattern']
    }
  },
  {
    name: 'edit_file',
    description:
      'Modifie un fichier existant en remplaçant exactement « old_string » par « new_string ». Lis le fichier avant. « old_string » doit être unique dans le fichier (ajoute du contexte sinon), sauf si « replace_all » vaut vrai. Les numéros de ligne affichés par read_file ne font pas partie du texte.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Texte exact à remplacer (indentation comprise).' },
        new_string: { type: 'string', description: 'Texte de remplacement.' },
        replace_all: { type: 'boolean', description: 'Remplacer toutes les occurrences.' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'write_file',
    description: 'Crée un fichier ou remplace entièrement son contenu. Pour une petite modification, préfère edit_file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string', description: 'Contenu complet du fichier.' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'delete_file',
    description: 'Supprime un fichier du projet (il est placé dans la corbeille).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'run_command',
    description:
      'Exécute une commande shell dans le dossier du projet et renvoie sa sortie et son code de retour. L’utilisateur peut devoir l’approuver. N’utilise pas de commande interactive ni de serveur qui ne se termine pas.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Commande à exécuter.' },
        timeout_seconds: { type: 'integer', description: 'Délai maximal (optionnel).' }
      },
      required: ['command']
    }
  },
  {
    name: 'get_problems',
    description: 'Renvoie les erreurs et avertissements signalés par l’éditeur (fichiers ouverts), éventuellement pour un fichier.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Fichier (optionnel).' } } }
  }
]

/**
 * Validation minimale des arguments d'un outil selon son schéma : champs requis et types simples.
 * Renvoie un message d'erreur, ou null si les arguments sont valides.
 */
export function validateToolInput(name: string, input: unknown): string | null {
  const tool = AGENT_TOOLS.find((t) => t.name === name)
  if (!tool) return `Outil inconnu : « ${name} ».`
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Les arguments doivent être un objet JSON.'
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] }
  const obj = input as Record<string, unknown>
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) return `Argument requis manquant : « ${key} ».`
  }
  for (const [key, value] of Object.entries(obj)) {
    const type = schema.properties?.[key]?.type
    if (!type || value === undefined || value === null) continue
    const ok =
      type === 'string'
        ? typeof value === 'string'
        : type === 'boolean'
          ? typeof value === 'boolean'
          : type === 'integer'
            ? Number.isInteger(value)
            : true
    if (!ok) return `Type invalide pour « ${key} » : ${type} attendu.`
  }
  return null
}

/** Outils qui modifient des fichiers (et justifient un point de restauration). */
export const MUTATING_TOOLS: ToolName[] = ['edit_file', 'write_file', 'delete_file']

/**
 * Convertit un chemin fourni par le modèle en chemin absolu dans le projet.
 * Refuse tout ce qui sort du projet ou vise le dossier .git.
 */
export function resolveWorkspacePath(root: string, input: string): { path: string } | { error: string } {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const raw = input.trim().replace(/\\/g, '/')
  if (!raw) return { error: 'Chemin vide.' }
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  let rel = raw
  if (/^([a-zA-Z]:\/|\/)/.test(raw)) {
    if (raw !== normRoot && !raw.startsWith(`${normRoot}/`)) return { error: `Chemin hors du projet refusé : ${input}` }
    rel = raw.slice(normRoot.length).replace(/^\/+/, '')
  }
  const parts: string[] = []
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return { error: `Chemin hors du projet refusé : ${input}` }
      parts.pop()
    } else parts.push(part)
  }
  if (parts[0] === '.git') return { error: 'Le dossier .git ne peut pas être modifié par l’agent.' }
  const joined = parts.join(sep)
  return { path: joined ? `${root.replace(/[\\/]+$/, '')}${sep}${joined}` : root }
}

/**
 * Une commande est autorisée sans confirmation si elle commence par une entrée de la liste
 * (mot entier) et ne contient aucun enchaînement ni redirection pouvant lancer autre chose.
 */
export function isCommandAllowed(command: string, settings: AgentSettings): boolean {
  if (settings.commandPolicy === 'always') return true
  const cmd = command.trim()
  if (/[;&|`<>]|\$\(|\n/.test(cmd)) return false
  return settings.allowlist.some((entry) => {
    const e = entry.trim()
    return e !== '' && (cmd === e || cmd.startsWith(`${e} `))
  })
}

export const MAX_TOOL_OUTPUT = 30_000

/** Tronque une sortie d'outil trop longue en gardant le début et la fin. */
export function truncateOutput(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.4)
  const tail = max - head
  return `${text.slice(0, head)}\n\n[… ${text.length - max} caractères omis …]\n\n${text.slice(-tail)}`
}

/** Applique un remplacement exact ; renvoie le nouveau contenu ou une erreur explicite pour le modèle. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): { content: string; count: number } | { error: string } {
  if (oldString === '') return { error: '« old_string » est vide : utilise write_file pour créer un fichier.' }
  if (oldString === newString) return { error: '« old_string » et « new_string » sont identiques.' }
  if (!content.includes(oldString) && content.includes('\r\n') && !oldString.includes('\r\n')) {
    // Fichier en fins de ligne Windows : on compare en LF puis on restaure les CRLF.
    const lf = applyEdit(content.replace(/\r\n/g, '\n'), oldString, newString, replaceAll)
    return 'error' in lf ? lf : { content: lf.content.replace(/\n/g, '\r\n'), count: lf.count }
  }
  const count = content.split(oldString).length - 1
  if (count === 0) return { error: '« old_string » est introuvable dans le fichier. Relis le fichier et copie le texte exact (indentation comprise).' }
  if (count > 1 && !replaceAll) {
    return { error: `« old_string » apparaît ${count} fois. Ajoute du contexte pour le rendre unique, ou utilise replace_all.` }
  }
  return { content: replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString), count: replaceAll ? count : 1 }
}

export function agentSystemPrompt(env: { os: string; workspace: string; date: string }): string {
  return [
    'Tu es un agent de programmation autonome intégré à l’éditeur « My Agent IDE ».',
    'Tu réalises la demande de l’utilisateur en utilisant les outils fournis pour explorer, modifier et vérifier le projet.',
    'Réponds dans la langue de l’utilisateur (le français par défaut).',
    '',
    `Projet ouvert : ${env.workspace}`,
    `Système : ${env.os}. Date : ${env.date}.`,
    '',
    'Méthode :',
    '- Explore d’abord ce qui est nécessaire (list_dir, find_files, search_text, read_file) ; ne devine pas le contenu d’un fichier.',
    '- Modifie avec edit_file (remplacement exact) ; utilise write_file pour créer un fichier ou le réécrire entièrement.',
    '- Vérifie ton travail quand c’est possible (tests, compilation, linter) avec run_command, puis corrige les erreurs.',
    '- Les chemins sont relatifs à la racine du projet. Ne touche qu’aux fichiers utiles à la demande.',
    '- Si une commande est refusée par l’utilisateur, ne la relance pas : adapte-toi ou demande-lui.',
    '- Entre les étapes, explique brièvement ce que tu fais. À la fin, résume les modifications effectuées.'
  ].join('\n')
}
