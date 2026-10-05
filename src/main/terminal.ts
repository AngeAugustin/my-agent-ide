import { ipcMain, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'

const terminals = new Map<number, pty.IPty>()
let nextId = 1

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
}

export function registerTerminalHandlers(
  getContents: () => WebContents | null,
  getShell: () => Promise<string>
): void {
  ipcMain.handle('terminal:create', async (_e, cwd: string | null, cols: number, rows: number) => {
    const shell = (await getShell()) || defaultShell()
    const id = nextId++
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      env: { ...process.env, TERM_PROGRAM: 'my-agent-ide', COLORTERM: 'truecolor' } as Record<string, string>
    })
    terminals.set(id, proc)
    proc.onData((data) => getContents()?.send('terminal:data', id, data))
    proc.onExit(({ exitCode }) => {
      terminals.delete(id)
      getContents()?.send('terminal:exit', id, exitCode)
    })
    return id
  })

  ipcMain.on('terminal:write', (_e, id: number, data: string) => terminals.get(id)?.write(data))
  ipcMain.on('terminal:resize', (_e, id: number, cols: number, rows: number) => {
    try {
      terminals.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1))
    } catch {
      // Le processus peut déjà être terminé.
    }
  })
  ipcMain.on('terminal:kill', (_e, id: number) => {
    terminals.get(id)?.kill()
    terminals.delete(id)
  })
}

export function killAllTerminals(): void {
  for (const proc of terminals.values()) proc.kill()
  terminals.clear()
}
