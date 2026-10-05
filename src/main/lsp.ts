import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Settings } from '@shared/types'
import { encodeLspMessage, LSP_SERVERS, LspFramer, type LspServerStatus } from '@shared/lsp'

interface Session {
  id: number
  serverId: string
  child: ChildProcess
}

const sessions = new Map<number, Session>()
let nextId = 1

/** Cherche un exécutable dans le projet (node_modules/.bin) puis dans le PATH. */
export function findExecutable(command: string, root: string | null): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  const dirs = [...(root ? [join(root, 'node_modules', '.bin')] : []), ...(process.env.PATH ?? '').split(delimiter)]
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, command + ext)
      if (existsSync(full)) return full
    }
  }
  return null
}

function bundledTypeScript(): { command: string; args: string[]; env: Record<string, string> } | null {
  try {
    const cli = require.resolve('typescript-language-server/lib/cli.mjs')
    // Dans l'application installée, les modules nécessaires sont extraits de l'archive asar.
    const unpacked = cli.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    return { command: process.execPath, args: [existsSync(unpacked) ? unpacked : cli, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } }
  } catch {
    return null
  }
}

export function tsserverPath(): string | null {
  // Application installée : copie complète de typescript/lib (avec les lib.*.d.ts) dans les ressources.
  const packaged = join(process.resourcesPath ?? '', 'typescript', 'lib', 'tsserver.js')
  if (process.resourcesPath && existsSync(packaged)) return packaged
  try {
    const p = require.resolve('typescript/lib/tsserver.js')
    const unpacked = p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    return existsSync(unpacked) ? unpacked : p
  } catch {
    return null
  }
}

function resolveServer(id: string, root: string | null): { command: string; args: string[]; env?: Record<string, string>; label: string } | null {
  const def = LSP_SERVERS.find((s) => s.id === id)
  if (!def) return null
  if (def.bundled && id === 'typescript') {
    const b = bundledTypeScript()
    return b ? { ...b, label: 'intégré' } : null
  }
  for (const c of def.commands) {
    const exe = findExecutable(c.command, root)
    if (exe) return { command: exe, args: c.args, label: c.command }
  }
  return null
}

export function registerLspHandlers(getContents: () => WebContents | null, getSettings: () => Promise<Settings>): void {
  ipcMain.handle('lsp:servers', async (_e, root: string | null): Promise<LspServerStatus[]> => {
    const settings = (await getSettings()).lsp
    return LSP_SERVERS.map((def) => {
      const resolved = resolveServer(def.id, root)
      return {
        id: def.id,
        name: def.name,
        extensions: def.extensions,
        available: !!resolved,
        command: resolved?.label,
        installHint: def.installHint,
        enabled: settings.enabled && !settings.disabled.includes(def.id)
      }
    })
  })

  ipcMain.handle('lsp:start', (_e, serverId: string, root: string) => {
    const resolved = resolveServer(serverId, root)
    if (!resolved) throw new Error(`Serveur de langage introuvable : ${serverId}`)
    const child = spawn(resolved.command, resolved.args, {
      cwd: root,
      env: { ...process.env, ...(resolved.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.command)
    })
    const id = nextId++
    sessions.set(id, { id, serverId, child })
    const framer = new LspFramer()
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const msg of framer.push(chunk)) getContents()?.send('lsp:message', id, msg)
    })
    child.stderr?.on('data', () => {
      // Les journaux des serveurs ne sont pas affichés.
    })
    child.on('exit', (code) => {
      sessions.delete(id)
      getContents()?.send('lsp:exit', id, code)
    })
    child.on('error', () => {
      sessions.delete(id)
      getContents()?.send('lsp:exit', id, -1)
    })
    return { id, rootUri: pathToFileURL(root).href, tsserverPath: serverId === 'typescript' ? tsserverPath() : null }
  })

  ipcMain.on('lsp:send', (_e, id: number, message: unknown) => {
    const s = sessions.get(id)
    if (s?.child.stdin?.writable) s.child.stdin.write(encodeLspMessage(message))
  })

  ipcMain.handle('lsp:stop', (_e, id: number) => stopSession(id))
}

function stopSession(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.child.stdin?.write(encodeLspMessage({ jsonrpc: '2.0', method: 'exit' }))
  } catch {
    // processus déjà arrêté
  }
  setTimeout(() => s.child.kill(), 500)
}

export function stopAllLsp(): void {
  for (const id of [...sessions.keys()]) stopSession(id)
}

