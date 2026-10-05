// Utilitaires de chemins indépendants de Node (l'interface tourne dans un navigateur).

export function sep(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return idx === 0 ? path.slice(0, 1) : path
  // Préserve la racine Windows (« C:\ »).
  if (/^[A-Za-z]:$/.test(path.slice(0, idx))) return path.slice(0, idx + 1)
  return path.slice(0, idx)
}

export function join(dir: string, name: string): string {
  const s = sep(dir)
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + s + name
}

export function relative(root: string, path: string): string {
  if (path === root) return ''
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : root + sep(root)
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export function extname(path: string): string {
  const name = basename(path)
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx).toLowerCase() : ''
}

export function isInside(parent: string, child: string): boolean {
  if (parent === child) return true
  const prefix = parent.endsWith('/') || parent.endsWith('\\') ? parent : parent + sep(parent)
  return child.startsWith(prefix)
}

/** Vérifie qu'un nom de fichier saisi par l'utilisateur est utilisable. */
export function validateFileName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Le nom ne peut pas être vide.'
  if (trimmed === '.' || trimmed === '..') return 'Ce nom est réservé.'
  if (/[<>:"|?*\u0000]/.test(trimmed)) return 'Le nom contient des caractères non autorisés.'
  if (/^[\\/]|[\\/]$/.test(trimmed)) return 'Le nom ne peut pas commencer ou finir par « / ».'
  return null
}
