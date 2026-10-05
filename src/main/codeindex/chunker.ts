export interface Chunk {
  /** Chemin relatif à la racine du projet (séparateurs « / »). */
  path: string
  startLine: number
  endLine: number
  text: string
}

const TARGET_LINES = 60
const MAX_LINES = 100
const MIN_LINES = 8
const MAX_CHUNK_CHARS = 6000

// Début de déclaration de haut niveau dans les langages courants.
const DECLARATION =
  /^(export\s+|pub(\(\w+\))?\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|default\s+|abstract\s+|final\s+|@\w+)*(function|class|interface|type|enum|const|let|var|def|fn|func|struct|impl|trait|module|namespace|object|package|func|record|sub|procedure)\b/

/** Une ligne est une bonne frontière si elle ouvre une déclaration non indentée ou suit une ligne vide. */
function isBoundary(lines: string[], i: number): boolean {
  const line = lines[i]
  if (DECLARATION.test(line)) return true
  return i > 0 && lines[i - 1].trim() === '' && line.trim() !== '' && !/^\s/.test(line)
}

/**
 * Découpe un fichier en extraits d'environ 60 lignes, en coupant de préférence au début
 * d'une déclaration de haut niveau ou après une ligne vide (approche indépendante du langage).
 */
export function chunkFile(path: string, content: string): Chunk[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const chunks: Chunk[] = []
  let start = 0
  while (start < lines.length) {
    let end = Math.min(start + TARGET_LINES, lines.length)
    if (end < lines.length) {
      // Cherche une frontière proche de la cible, d'abord après, puis avant.
      let cut = -1
      for (let i = end; i < Math.min(start + MAX_LINES, lines.length); i++) {
        if (isBoundary(lines, i)) {
          cut = i
          break
        }
      }
      if (cut === -1) {
        for (let i = end - 1; i > start + MIN_LINES; i--) {
          if (isBoundary(lines, i)) {
            cut = i
            break
          }
        }
      }
      if (cut !== -1) end = cut
    }
    // Évite un dernier extrait minuscule.
    if (lines.length - end < MIN_LINES && end < lines.length && end - start + (lines.length - end) <= MAX_LINES) end = lines.length
    let text = lines.slice(start, end).join('\n')
    if (text.length > MAX_CHUNK_CHARS) text = text.slice(0, MAX_CHUNK_CHARS)
    if (text.trim()) chunks.push({ path, startLine: start + 1, endLine: end, text })
    start = end
  }
  return chunks
}

const SKIP_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf', 'zip', 'gz', 'tar', 'tgz', '7z', 'rar', 'woff', 'woff2',
  'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'pyc',
  'o', 'a', 'wasm', 'map', 'lock', 'db', 'sqlite', 'psd'
])
const SKIP_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'composer.lock', 'go.sum'])

/** Indique si un fichier mérite d'être indexé (texte source, pas un fichier généré ou binaire). */
export function isIndexable(relPath: string): boolean {
  const name = relPath.split('/').pop() ?? relPath
  if (SKIP_NAMES.has(name)) return false
  if (/\.min\.(js|css)$/.test(name)) return false
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return !SKIP_EXTENSIONS.has(ext)
}
