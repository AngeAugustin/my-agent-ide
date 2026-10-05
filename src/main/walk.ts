import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface WalkOptions {
  excluded: string[]
  maxFiles?: number
}

/** Parcourt récursivement un dossier et renvoie les chemins absolus des fichiers. */
export async function walkFiles(root: string, options: WalkOptions): Promise<string[]> {
  const excluded = new Set(options.excluded)
  const max = options.maxFiles ?? 50_000
  const files: string[] = []
  const stack = [root]

  while (stack.length > 0 && files.length < max) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        files.push(full)
        if (files.length >= max) break
      }
    }
  }
  return files.sort()
}
