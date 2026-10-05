import { ipcMain, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import type { DebugConfig, SourceBreakpoint } from '@shared/debug'
import type { DebugBackend } from './backend'
import { DapDebugBackend, findPython } from './dap'
import { NodeDebugBackend } from './node'

const sessions = new Map<number, DebugBackend>()
let nextId = 1

function session(id: number): DebugBackend {
  const s = sessions.get(id)
  if (!s) throw new Error('Session de débogage introuvable.')
  return s
}

export function registerDebugHandlers(getContents: () => WebContents | null): void {
  ipcMain.handle('debug:start', async (_e, config: DebugConfig, breakpoints: Record<string, SourceBreakpoint[]>) => {
    if (!existsSync(config.program)) throw new Error(`Fichier introuvable : ${config.program}`)
    if (!existsSync(config.cwd)) throw new Error(`Dossier de travail introuvable : ${config.cwd}`)
    const id = nextId++
    const emit = (event: Parameters<ConstructorParameters<typeof NodeDebugBackend>[1]>[0]) => {
      getContents()?.send('debug:event', id, event)
      if (event.type === 'terminated') sessions.delete(id)
    }
    let backend: DebugBackend
    if (config.type === 'node') backend = new NodeDebugBackend(config, emit)
    else {
      const py = findPython(config.runtime, config.cwd)
      if ('error' in py) throw new Error(py.error)
      backend = new DapDebugBackend(
        config,
        {
          command: py.python,
          args: ['-m', 'debugpy.adapter'],
          adapterID: 'debugpy',
          launchArgs: {
            name: config.name,
            type: 'python',
            request: 'launch',
            program: config.program,
            args: config.args,
            cwd: config.cwd,
            env: config.env,
            python: [py.python],
            console: 'internalConsole',
            stopOnEntry: config.stopOnEntry,
            justMyCode: config.justMyCode ?? true,
            redirectOutput: true,
            showReturnValue: true
          }
        },
        emit
      )
    }
    for (const [path, bps] of Object.entries(breakpoints)) if (bps.length) await backend.setBreakpoints(path, bps)
    sessions.set(id, backend)
    try {
      await backend.start()
    } catch (err) {
      sessions.delete(id)
      await backend.stop().catch(() => {})
      throw err
    }
    return id
  })
  ipcMain.handle('debug:setBreakpoints', (_e, id: number, path: string, bps: SourceBreakpoint[]) => session(id).setBreakpoints(path, bps))
  ipcMain.handle('debug:resume', (_e, id: number) => session(id).resume())
  ipcMain.handle('debug:stepOver', (_e, id: number) => session(id).stepOver())
  ipcMain.handle('debug:stepInto', (_e, id: number) => session(id).stepInto())
  ipcMain.handle('debug:stepOut', (_e, id: number) => session(id).stepOut())
  ipcMain.handle('debug:pause', (_e, id: number) => session(id).pause())
  ipcMain.handle('debug:stackTrace', (_e, id: number) => session(id).stackTrace())
  ipcMain.handle('debug:scopes', (_e, id: number, frameId: number) => session(id).scopes(frameId))
  ipcMain.handle('debug:variables', (_e, id: number, ref: number) => session(id).variables(ref))
  ipcMain.handle('debug:evaluate', (_e, id: number, expression: string, frameId?: number) => session(id).evaluate(expression, frameId))
  ipcMain.handle('debug:stop', async (_e, id: number) => {
    const s = sessions.get(id)
    sessions.delete(id)
    await s?.stop()
  })
}

export function stopAllDebug(): void {
  for (const s of sessions.values()) void s.stop()
  sessions.clear()
}
