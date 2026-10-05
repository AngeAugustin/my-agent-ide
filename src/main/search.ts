import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import type { SearchFileResult, SearchOptions, SearchResult } from '@shared/types'
import { walkFiles } from './walk'

const MAX_MATCHES = 5_000
const MAX_FILE_SIZE = 2 * 1024 * 1024
const PREVIEW_LENGTH = 200

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Construit l'expression régulière de recherche. Lève une erreur si la regex est invalide. */
export function buildSearchRegExp(query: string, options: SearchOptions): RegExp {
  let source = options.regex ? query : escapeRegExp(query)
  if (options.wholeWord) source = `\\b(?:${source})\\b`
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
}

/** Convertit un motif glob simple (`*.ts, src/**`) en liste de regex. */
export function globsToRegExps(patterns: string | undefined): RegExp[] {
  if (!patterns) return []
  return patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const source = p
        .split('**')
        .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
        .join('.*')
        .replace(/\\\?/g, '.')
      // Un motif sans « / » s'applique au nom de fichier n'importe où dans l'arborescence.
      return p.includes('/') ? new RegExp(`^${source}`) : new RegExp(`(^|/)${source}$`)
    })
}

function isProbablyBinary(content: string): boolean {
  return content.slice(0, 8000).includes('\u0000')
}

export function searchInContent(content: string, regex: RegExp): SearchFileResult['matches'] {
  const matches: SearchFileResult['matches'] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(line)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++
        continue
      }
      const start = Math.max(0, m.index - 40)
      matches.push({
        line: i + 1,
        column: m.index + 1,
        length: m[0].length,
        preview: (start > 0 ? '…' : '') + line.slice(start, start + PREVIEW_LENGTH).trimEnd()
      })
    }
  }
  return matches
}

export async function searchText(
  root: string,
  query: string,
  options: SearchOptions,
  excluded: string[]
): Promise<SearchResult> {
  const result: SearchResult = { files: [], totalMatches: 0, truncated: false }
  if (!query) return result

  const regex = buildSearchRegExp(query, options)
  const includes = globsToRegExps(options.include)
  const excludes = globsToRegExps(options.exclude)
  const files = await walkFiles(root, { excluded })

  for (const file of files) {
    const rel = relative(root, file).split('\\').join('/')
    if (includes.length > 0 && !includes.some((r) => r.test(rel))) continue
    if (excludes.some((r) => r.test(rel))) continue

    let content: string
    try {
      const stat = await fs.stat(file)
      if (stat.size > MAX_FILE_SIZE) continue
      content = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    if (isProbablyBinary(content)) continue

    const matches = searchInContent(content, regex)
    if (matches.length === 0) continue
    result.files.push({ path: file, matches })
    result.totalMatches += matches.length
    if (result.totalMatches >= MAX_MATCHES) {
      result.truncated = true
      break
    }
  }
  return result
}
