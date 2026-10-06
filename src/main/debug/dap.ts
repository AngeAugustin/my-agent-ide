import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { encodeLspMessage, LspFramer } from '@shared/lsp'
import type { BreakpointResult, DebugConfig, DebugFrame, DebugScope, DebugVariable, SourceBreakpoint } from '@shared/debug'
import { findExecutable } from '../lsp'
import type { DebugBackend, EmitDebugEvent } from './backend'

interface DapMessage {
  seq: number
  type: 'request' | 'response' | 'event'
  command?: string
  event?: string
  request_seq?: number
  success?: boolean
  message?: string
  body?: any
  arguments?: any
}

/** Trouve un interpréteur Python disposant du module debugpy. */
export function findPython(preferred: string | undefined, cwd: string): { python: string } | { error: string } {
  const candidates = [
    preferred,
    findExecutable(process.platform === 'win32' ? 'python' : 'python3', cwd),
    findExecutable('python', cwd),
    process.platform === 'win32' ? findExecutable('py', cwd) : null
  ].filter((c): c is string => !!c)
  // Environnement virtuel du projet en priorité.
  for (const venv of ['.venv', 'venv']) {
    const p = process.platform === 'win32' ? `${cwd}\\${venv}\\Scripts\\python.exe` : `${cwd}/${venv}/bin/python`
    candidates.splice(preferred ? 1 : 0, 0, p)
  }
  let found: string | null = null
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import debugpy'], { cwd, timeout: 10_000, windowsHide: true })
    if (r.error) continue
    found ??= c
    if (r.status === 0) return { python: c }
  }
  return {
    error: found
      ? `Le module « debugpy » n’est pas installé pour ${found}. Installez-le avec : ${found} -m pip install debugpy`
      : 'Aucun interpréteur Python n’a été trouvé. Installez Python 3, ou indiquez son chemin (« python ») dans .vscode/launch.json.'
  }
}

/** Client du protocole DAP (Debug Adapter Protocol) sur l'entrée / sortie d'un adaptateur. */
export class DapDebugBackend implements DebugBackend {
  private child: ChildProcess | null = null
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private readonly framer = new LspFramer()
  private readonly wanted = new Map<string, SourceBreakpoint[]>()
  private threadId = 1
  private configured = false
  private terminated = false

  constructor(
    private readonly config: DebugConfig,
    private readonly adapter: { command: string; args: string[]; launchArgs: Record<string, unknown>; adapterID: string },
    private readonly emit: EmitDebugEvent
  ) {}

  private request<T = any>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Session de débogage terminée.'))
    const seq = ++this.seq
    this.child.stdin.write(encodeLspMessage({ seq, type: 'request', command, arguments: args }))
    return new Promise<T>((resolve, reject) => this.pending.set(seq, { resolve, reject }))
  }

  async start(): Promise<void> {
    const child = spawn(this.adapter.command, this.adapter.args, { cwd: this.config.cwd, env: { ...process.env, ...this.config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', (d: Buffer) => {
      for (const m of this.framer.push(d)) this.onMessage(m as DapMessage)
    })
    child.stderr?.on('data', (d: Buffer) => this.emit({ type: 'output', category: 'stderr', text: d.toString('utf8') }))
    child.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('L’adaptateur de débogage s’est arrêté.'))
      this.pending.clear()
      this.finish(null)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e) => reject(new Error(`Impossible de lancer l’adaptateur de débogage : ${e.message}`)))
    })

    const initialized = new Promise<void>((resolve) => (this.onInitialized = resolve))
    await this.request('initialize', {
      clientID: 'my-agent-ide',
      clientName: 'My Agent IDE',
      adapterID: this.adapter.adapterID,
      locale: 'fr',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false
    })
    // La réponse à « launch » n'arrive qu'après « configurationDone » : on ne l'attend pas tout de suite.
    const launched = this.request('launch', this.adapter.launchArgs)
    launched.catch(() => {})
    await Promise.race([initialized, launched.then(() => initialized)])
    for (const [path, bps] of this.wanted) await this.sendBreakpoints(path, bps)
    // Arrêt sur les exceptions non interceptées.
    await this.request('setExceptionBreakpoints', { filters: ['uncaught'] }).catch(() => {})
    await this.request('configurationDone').catch(() => {})
    this.configured = true
    await launched
  }

  private onInitialized: () => void = () => {}

  private onMessage(msg: DapMessage): void {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq!)
      this.pending.delete(msg.request_seq!)
      if (msg.success) p?.resolve(msg.body ?? {})
      else p?.reject(new Error(msg.body?.error?.format ?? msg.message ?? 'Erreur de l’adaptateur.'))
      return
    }
    if (msg.type === 'request') {
      // Requêtes inverses (runInTerminal…) : non prises en charge.
      this.child?.stdin?.write(encodeLspMessage({ seq: ++this.seq, type: 'response', request_seq: msg.seq, command: msg.command, success: false, message: 'Non pris en charge' }))
      return
    }
    const body = msg.body ?? {}
    switch (msg.event) {
      case 'initialized':
        this.onInitialized()
        break
      case 'stopped':
        if (body.threadId) this.threadId = body.threadId
        this.emit({ type: 'stopped', reason: body.reason ?? 'pause', description: body.text ?? (body.reason === 'exception' ? body.description : undefined), threadId: body.threadId })
        break
      case 'continued':
        this.emit({ type: 'continued' })
        break
      case 'output':
        if (body.category === 'telemetry') break
        this.emit({ type: 'output', category: body.category === 'stderr' ? 'stderr' : body.category === 'stdout' ? 'stdout' : body.category === 'important' ? 'info' : 'console', text: String(body.output ?? '') })
        break
      case 'exited':
        this.exitCode = body.exitCode ?? null
        break
      case 'terminated':
        void this.request('disconnect', { terminateDebuggee: true }).catch(() => {})
        this.finish(this.exitCode)
        break
    }
  }

  private exitCode: number | null = null

  private finish(code: number | null): void {
    if (this.terminated) return
    this.terminated = true
    this.emit({ type: 'terminated', exitCode: code })
    setTimeout(() => this.child?.kill(), 1000)
  }

  private async sendBreakpoints(path: string, bps: SourceBreakpoint[]): Promise<BreakpointResult[]> {
    const active = bps.filter((b) => b.enabled !== false)
    const res = await this.request<{ breakpoints: Array<{ verified: boolean; line?: number; message?: string }> }>('setBreakpoints', {
      source: { path },
      breakpoints: active.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })),
      lines: active.map((b) => b.line)
    })
    return active.map((b, i) => ({ line: res.breakpoints[i]?.line ?? b.line, verified: res.breakpoints[i]?.verified ?? false, message: res.breakpoints[i]?.message }))
  }

  async setBreakpoints(path: string, breakpoints: SourceBreakpoint[]): Promise<BreakpointResult[]> {
    this.wanted.set(path, breakpoints)
    if (!this.configured) return breakpoints.map((b) => ({ line: b.line, verified: true }))
    return this.sendBreakpoints(path, breakpoints)
  }

  async resume(): Promise<void> {
    await this.request('continue', { threadId: this.threadId })
    this.emit({ type: 'continued' })
  }
  async stepOver(): Promise<void> {
    await this.request('next', { threadId: this.threadId })
    this.emit({ type: 'continued' })
  }
  async stepInto(): Promise<void> {
    await this.request('stepIn', { threadId: this.threadId })
    this.emit({ type: 'continued' })
  }
  async stepOut(): Promise<void> {
    await this.request('stepOut', { threadId: this.threadId })
    this.emit({ type: 'continued' })
  }
  async pause(): Promise<void> {
    await this.request('pause', { threadId: this.threadId })
  }

  async stackTrace(): Promise<DebugFrame[]> {
    const res = await this.request<{ stackFrames: Array<{ id: number; name: string; line: number; column: number; source?: { path?: string }; presentationHint?: string }> }>('stackTrace', {
      threadId: this.threadId,
      levels: 100
    })
    return res.stackFrames.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path,
      line: f.line,
      column: f.column,
      external: !f.source?.path || f.presentationHint === 'subtle' || /[\\/](site-packages|dist-packages|lib[\\/]python\d)/.test(f.source.path)
    }))
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    const res = await this.request<{ scopes: Array<{ name: string; variablesReference: number; expensive?: boolean }> }>('scopes', { frameId })
    const names: Record<string, string> = { Locals: 'Locales', Globals: 'Globales' }
    return res.scopes.map((s) => ({ name: names[s.name] ?? s.name, ref: s.variablesReference, expensive: s.expensive }))
  }

  async variables(ref: number): Promise<DebugVariable[]> {
    const res = await this.request<{ variables: Array<{ name: string; value: string; type?: string; variablesReference: number }> }>('variables', { variablesReference: ref })
    return res.variables
      .filter((v) => !/^(special|function) variables$/.test(v.name))
      .slice(0, 500)
      .map((v) => ({ name: v.name, value: v.value, type: v.type, ref: v.variablesReference }))
  }

  async evaluate(expression: string, frameId?: number): Promise<{ value: string; ref: number }> {
    const res = await this.request<{ result: string; variablesReference: number }>('evaluate', { expression, frameId, context: 'repl' })
    return { value: res.result, ref: res.variablesReference }
  }

  async stop(): Promise<void> {
    await Promise.race([this.request('disconnect', { terminateDebuggee: true }).catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
    this.child?.kill()
    this.finish(this.exitCode)
  }
}
