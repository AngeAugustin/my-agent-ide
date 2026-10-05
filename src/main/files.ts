import { ipcMain, shell, type WebContents } from 'electron'
import { existsSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileEntry, FsChangeEvent, SearchOptions } from '@shared/types'
import { searchText } from './search'
import { walkFiles } from './walk'

let watcher: FSWatcher | null = null
let pending: FsChangeEvent[] = []
let flushTimer: NodeJS.Timeout | null = null

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true })
  })
}

export function registerFileHandlers(
  getContents: () => WebContents | null,
  getExcluded: () => Promise<string[]>
): void {
  ipcMain.handle('fs:readDir', async (_e, dir: string): Promise<FileEntry[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return sortEntries(
      entries
        .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
        .map((e) => ({ name: e.name, path: join(dir, e.name), isDirectory: e.isDirectory() }))
    )
  })

  ipcMain.handle('fs:readFile', (_e, path: string) => fs.readFile(path, 'utf8'))

  ipcMain.handle('fs:writeFile', async (_e, path: string, content: string) => {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, content, 'utf8')
  })

  ipcMain.handle('fs:createFile', async (_e, path: string) => {
    if (existsSync(path)) throw new Error(`Le fichier « ${path} » existe déjà.`)
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, '', 'utf8')
  })

  ipcMain.handle('fs:createDir', async (_e, path: string) => {
    if (existsSync(path)) throw new Error(`Le dossier « ${path} » existe déjà.`)
    await fs.mkdir(path, { recursive: true })
  })

  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    if (existsSync(to)) throw new Error(`« ${to} » existe déjà.`)
    await fs.rename(from, to)
  })

  ipcMain.handle('fs:trash', (_e, path: string) => shell.trashItem(path))
  ipcMain.handle('fs:exists', (_e, path: string) => existsSync(path))

  ipcMain.handle('fs:listFiles', async (_e, root: string) =>
    walkFiles(root, { excluded: await getExcluded() })
  )

  ipcMain.handle('search:text', async (_e, root: string, query: string, options: SearchOptions) =>
    searchText(root, query, options, await getExcluded())
  )

  ipcMain.handle('fs:watch', (_e, root: string) => {
    watcher?.close()
    watcher = null
    try {
      watcher = watch(root, { recursive: true }, (type, filename) => {
        if (!filename) return
        const name = filename.toString()
        if (name.startsWith('.git') || name.includes('node_modules')) return
        pending.push({ type: type as FsChangeEvent['type'], path: join(root, name) })
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            getContents()?.send('fs:changed', pending)
            pending = []
            flushTimer = null
          }, 150)
        }
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      // La surveillance récursive n'est pas disponible partout ; on s'en passe.
    }
  })
}

export function stopWatching(): void {
  watcher?.close()
  watcher = null
}
