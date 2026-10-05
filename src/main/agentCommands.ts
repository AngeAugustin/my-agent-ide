import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

const MAX_OUTPUT = 400_000
const running = new Map<string, ChildProcess>()

export interface CommandResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  killed: boolean
  truncated: boolean
}

/** Arrête le processus et ses enfants (groupe de processus sous Unix, taskkill sous Windows). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput: (chunk: string) => void
): { child: ChildProcess; done: Promise<CommandResult> } {
  const child = spawn(command, {
    cwd,
    shell: process.platform === 'win32' ? true : process.env.SHELL || '/bin/sh',
    detached: process.platform !== 'win32',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', GIT_PAGER: 'cat', PAGER: 'cat' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let truncated = false
  let timedOut = false
  let killed = false
  const append = (data: Buffer) => {
    const text = data.toString('utf8')
    onOutput(text)
    if (output.length < MAX_OUTPUT) output += text.slice(0, MAX_OUTPUT - output.length)
    else truncated = true
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, timeoutMs)

  const done = new Promise<CommandResult>((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: null, output: `${output}${err.message}`, timedOut, killed, truncated })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, output, timedOut, killed, truncated })
    })
  })
  const markKilled = () => {
    killed = true
    killTree(child)
  }
  ;(child as ChildProcess & { markKilled?: () => void }).markKilled = markKilled
  return { child, done }
}

export function registerAgentHandlers(getContents: () => WebContents | null): void {
  ipcMain.handle('agent:run', async (_e, id: string, command: string, cwd: string, timeoutSeconds: number) => {
    if (!existsSync(cwd)) throw new Error(`Dossier introuvable : ${cwd}`)
    const timeout = Math.min(Math.max(timeoutSeconds, 1), 3600) * 1000
    const { child, done } = runCommand(command, cwd, timeout, (chunk) => getContents()?.send('agent:output', id, chunk))
    running.set(id, child)
    try {
      return await done
    } finally {
      running.delete(id)
    }
  })

  ipcMain.on('agent:kill', (_e, id: string) => {
    const child = running.get(id) as (ChildProcess & { markKilled?: () => void }) | undefined
    child?.markKilled?.()
  })
}

export function killAllAgentCommands(): void {
  for (const child of running.values()) killTree(child)
  running.clear()
}
