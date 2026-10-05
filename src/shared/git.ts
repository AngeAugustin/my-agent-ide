// Types Git partagés entre le processus principal et l'interface.

export interface GitFileStatus {
  /** Chemin relatif à la racine du dépôt. */
  path: string
  /** État dans l'index (lettre de `git status --porcelain`). */
  index: string
  /** État dans l'arbre de travail. */
  worktree: string
  origPath?: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
}

export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
}

/** Libellé et couleur d'un état de fichier pour l'interface. */
export function describeStatus(code: string): { letter: string; label: string; kind: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed' | 'conflict' } {
  switch (code) {
    case 'A':
      return { letter: 'A', label: 'ajouté', kind: 'added' }
    case 'D':
      return { letter: 'D', label: 'supprimé', kind: 'deleted' }
    case 'R':
      return { letter: 'R', label: 'renommé', kind: 'renamed' }
    case 'C':
      return { letter: 'C', label: 'copié', kind: 'added' }
    case '?':
      return { letter: 'U', label: 'non suivi', kind: 'untracked' }
    case 'U':
      return { letter: '!', label: 'en conflit', kind: 'conflict' }
    default:
      return { letter: 'M', label: 'modifié', kind: 'modified' }
  }
}

/** Fichier avec modifications indexées (prêtes à être commitées). */
export function isStaged(f: GitFileStatus): boolean {
  return f.index !== ' ' && f.index !== '?' && f.index !== '!'
}

/** Fichier avec modifications non indexées (ou non suivi). */
export function isUnstaged(f: GitFileStatus): boolean {
  return f.worktree !== ' ' || f.index === '?'
}

export function isConflict(f: GitFileStatus): boolean {
  return f.index === 'U' || f.worktree === 'U' || (f.index === 'A' && f.worktree === 'A') || (f.index === 'D' && f.worktree === 'D')
}
