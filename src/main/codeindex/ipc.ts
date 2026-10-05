import { app, ipcMain, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Settings } from '@shared/types'
import type { AiService } from '../ai/service'
import { onWorkspaceChange } from '../files'
import { walkFiles } from '../walk'
import { CodebaseIndex, type IndexStatus, type PersistedIndex } from './indexer'

let current: CodebaseIndex | null = null
let currentRoot: string | null = null
let updateTimer: NodeJS.Timeout | null = null
const pendingPaths = new Set<string>()

function indexFile(root: string): string {
  const key = createHash('sha1').update(root).digest('hex').slice(0, 16)
  return join(app.getPath('userData'), 'index', `${key}.json`)
}

const toRel = (root: string, abs: string) => relative(root, abs).split(sep).join('/')

/** Fichiers du projet : `git ls-files` si c'est un dépôt (respecte .gitignore), sinon parcours du disque. */
async function listProjectFiles(root: string, excluded: string[]): Promise<string[]> {
  const excludedSet = new Set(excluded)
  const keep = (rel: string) => rel !== '' && !rel.split('/').some((part) => excludedSet.has(part))
  if (existsSync(join(root, '.git'))) {
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        )
      )
      return out.split('\0').filter(keep)
    } catch {
      // git indisponible : on parcourt le disque.
    }
  }
  return (await walkFiles(root, { excluded })).map((f) => toRel(root, f)).filter(keep)
}

export function registerIndexHandlers(
  getContents: () => WebContents | null,
  getSettings: () => Promise<Settings>,
  ai: AiService
): void {
  const send = (status: IndexStatus) => getContents()?.send('index:status', status)

  /** Branche le modèle d'embeddings choisi dans les paramètres (ou aucun). */
  async function configureEmbedder(index: CodebaseIndex): Promise<void> {
    const ref = (await getSettings()).ai.models.embeddings
    if (!ref) return index.setEmbedder(null, null)
    index.setEmbedder((texts, inputType) => ai.embed(ref.providerId, ref.modelId, texts, inputType), `${ref.providerId}::${ref.modelId}`)
  }

  async function open(root: string): Promise<IndexStatus> {
    if (currentRoot === root && current) return current.getStatus()
    current?.dispose()
    currentRoot = root
    const file = indexFile(root)
    const index = new CodebaseIndex({
      root,
      listFiles: async () => listProjectFiles(root, (await getSettings()).excludedFolders),
      stat: async (rel) => {
        try {
          const st = await fs.stat(join(root, rel))
          return st.isFile() ? { mtime: st.mtimeMs, size: st.size } : null
        } catch {
          return null
        }
      },
      readFile: (rel) => fs.readFile(join(root, rel), 'utf8'),
      load: async () => {
        try {
          return JSON.parse(await fs.readFile(file, 'utf8')) as PersistedIndex
        } catch {
          return null
        }
      },
      save: async (data) => {
        await fs.mkdir(join(app.getPath('userData'), 'index'), { recursive: true })
        await fs.writeFile(`${file}.tmp`, JSON.stringify(data))
        await fs.rename(`${file}.tmp`, file)
      },
      onStatus: (status) => {
        if (current === index) send(status)
      }
    })
    current = index
    await configureEmbedder(index)
    await index.load()
    void index.sync()
    return index.getStatus()
  }

  onWorkspaceChange((root, events) => {
    if (!current || root !== currentRoot) return
    for (const ev of events) pendingPaths.add(toRel(root, ev.path))
    if (updateTimer) clearTimeout(updateTimer)
    updateTimer = setTimeout(() => {
      updateTimer = null
      const paths = [...pendingPaths]
      pendingPaths.clear()
      void current?.update(paths.filter((p) => !p.startsWith('..')))
    }, 1500)
  })

  ipcMain.handle('index:open', (_e, root: string) => open(root))
  ipcMain.handle('index:status', () => current?.getStatus() ?? null)
  ipcMain.handle('index:rebuild', async () => {
    if (!current) return
    await configureEmbedder(current)
    void current.sync()
  })
  ipcMain.handle('index:enableEmbeddings', async (_e, enabled: boolean) => {
    if (!current) return
    await configureEmbedder(current)
    current.setEmbeddingsEnabled(enabled)
    void current.sync()
  })
  ipcMain.handle('index:clear', async () => {
    if (!currentRoot) return
    const root = currentRoot
    current?.dispose()
    current = null
    currentRoot = null
    await fs.rm(indexFile(root), { force: true })
    await open(root)
  })
  ipcMain.handle('index:search', async (_e, query: string, limit?: number) => {
    if (!current) throw new Error('Aucun projet indexé : ouvrez un dossier.')
    return current.search(query, limit)
  })
  /** Appelé quand les paramètres changent (ex. nouveau modèle d'embeddings). */
  ipcMain.handle('index:settingsChanged', async () => {
    if (current) await configureEmbedder(current)
  })
}
