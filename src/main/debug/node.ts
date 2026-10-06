import { spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  formatRemoteObject,
  isInspectorNoise,
  nodeUrlRegex,
  nodeUrlToPath,
  type BreakpointResult,
  type DebugConfig,
  type DebugFrame,
  type DebugScope,
  type DebugVariable,
  type SourceBreakpoint
} from '@shared/debug'
import { findExecutable } from '../lsp'
import { LineBuffer, type DebugBackend, type EmitDebugEvent } from './backend'

interface RemoteObject {
  type: string
  subtype?: string
  className?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  objectId?: string
}

interface CallFrame {
  callFrameId: string
  functionName: string
  location: { scriptId: string; lineNumber: number; columnNumber?: number }
  url: string
  scopeChain: Array<{ type: string; name?: string; object: RemoteObject }>
}

const SCOPE_NAMES: Record<string, string> = {
  local: 'Locales',
  closure: 'Fermeture',
  block: 'Bloc',
  catch: 'Exception',
  script: 'Script',
  module: 'Module',
  with: 'With',
  global: 'Globales',
  eval: 'Eval'
}

/** Débogage Node.js : lance `node --inspect-brk` et pilote le programme par l'inspecteur V8. */
export class NodeDebugBackend implements DebugBackend {
  private child: ChildProcess | null = null
  private ws: WebSocket | null = null
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private readonly scripts = new Map<string, string>()
  private frames: CallFrame[] = []
  private readonly objects = new Map<number, string>()
  private nextRef = 1
  /** Points d'arrêt par fichier (identifiants de l'inspecteur). */
  private readonly breakpointIds = new Map<string, string[]>()
  private readonly wanted = new Map<string, SourceBreakpoint[]>()
  private entryHandled = false
  private terminated = false
  private readonly windows = process.platform === 'win32'

  constructor(
    private readonly config: DebugConfig,
    private readonly emit: EmitDebugEvent
  ) {}

  private send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Le programme n’est plus en cours d’exécution.'))
    const id = ++this.seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async start(): Promise<void> {
    const runtime = this.config.runtime || findExecutable('node', this.config.cwd)
    // Sans Node.js installé, le moteur d'Electron fait office de Node.
    const command = runtime ?? process.execPath
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.config.env, ...(runtime ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }
    delete env.NODE_OPTIONS
    const child = spawn(command, ['--inspect-brk=127.0.0.1:0', this.config.program, ...this.config.args], {
      cwd: this.config.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    const out = new LineBuffer()
    const err = new LineBuffer()
    child.stdout?.on('data', (d: Buffer) => out.push(d.toString('utf8')).forEach((text) => this.emit({ type: 'output', category: 'stdout', text })))

    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Node.js n’a pas démarré l’inspecteur à temps.')), 15_000)
      let found = false
      child.stderr?.on('data', (d: Buffer) => {
        for (const line of err.push(d.toString('utf8'))) {
          const m = /Debugger listening on (ws:\/\/\S+)/.exec(line)
          if (m && !found) {
            found = true
            clearTimeout(timer)
            resolve(m[1])
          }
          if (!isInspectorNoise(line)) this.emit({ type: 'output', category: 'stderr', text: line })
        }
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`Impossible de lancer ${command} : ${e.message}`))
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (!found) reject(new Error(`Node.js s’est arrêté avant le débogage (code ${code}).`))
      })
    })
    child.on('exit', (code) => {
      const rest = out.flush()
      if (rest) this.emit({ type: 'output', category: 'stdout', text: rest })
      this.finish(code)
    })

    const ws = new WebSocket(wsUrl)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('Connexion à l’inspecteur de Node.js impossible.'))
    })
    ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)))
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('Session de débogage terminée.'))
      this.pending.clear()
    }

    await this.send('Runtime.enable')
    await this.send('Debugger.enable')
    // Arrêt sur les exceptions non interceptées (comme VS Code par défaut).
    await this.send('Debugger.setPauseOnExceptions', { state: 'uncaught' })
    for (const [path, bps] of this.wanted) await this.applyBreakpoints(path, bps)
    await this.send('Runtime.runIfWaitingForDebugger')
  }

  private onMessage(msg: { id?: number; method?: string; params?: any; result?: any; error?: { message: string } }): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p?.reject(new Error(msg.error.message))
      else p?.resolve(msg.result)
      return
    }
    switch (msg.method) {
      case 'Debugger.scriptParsed':
        this.scripts.set(msg.params.scriptId, msg.params.url)
        break
      case 'Debugger.paused': {
        this.frames = msg.params.callFrames as CallFrame[]
        this.objects.clear()
        const reason = String(msg.params.reason)
        // Premier arrêt imposé par --inspect-brk : on continue sauf si l'arrêt à l'entrée est demandé.
        if (!this.entryHandled) {
          this.entryHandled = true
          if (!this.config.stopOnEntry && !(msg.params.hitBreakpoints?.length > 0)) {
            void this.send('Debugger.resume').catch(() => {})
            return
          }
        }
        const hit = msg.params.hitBreakpoints?.length > 0
        this.emit({
          type: 'stopped',
          reason: hit ? 'breakpoint' : reason === 'exception' || reason === 'promiseRejection' ? 'exception' : reason === 'other' ? 'step' : reason,
          description:
            reason === 'exception' || reason === 'promiseRejection'
              ? formatRemoteObject(msg.params.data ?? { type: 'object' }).split('\n')[0]
              : undefined
        })
        break
      }
      case 'Debugger.resumed':
        this.frames = []
        this.emit({ type: 'continued' })
        break
      // console.log écrit aussi sur la sortie standard (déjà affichée, avec le formatage de Node) :
      // Runtime.consoleAPICalled est donc ignoré pour éviter les doublons.
      case 'Runtime.exceptionThrown': {
        const d = msg.params.exceptionDetails
        this.emit({ type: 'output', category: 'stderr', text: `${d.exception?.description ?? d.text}\n` })
        break
      }
      case 'Runtime.executionContextDestroyed':
        // Fin du programme : Node attend que le débogueur se déconnecte pour quitter.
        this.ws?.close()
        break
    }
  }

  private finish(code: number | null): void {
    if (this.terminated) return
    this.terminated = true
    this.ws?.close()
    this.emit({ type: 'terminated', exitCode: code })
  }

  /** Chemin réel (liens symboliques résolus) → chemin connu de l'éditeur. */
  private readonly aliases = new Map<string, string>()

  /**
   * Node identifie les scripts par leur chemin réel : un dossier atteint par un lien symbolique
   * (ex. /var → /private/var sous macOS) doit être reconnu sous ses deux formes.
   */
  private urlRegexFor(path: string): string {
    // Node résout les liens avec sa propre version de realpath (qui garde, sous Windows, les noms
    // courts comme RUNNER~1) ; la version native les développe : on accepte toutes les formes.
    const forms = new Set([path])
    for (const resolve of [realpathSync, realpathSync.native]) {
      try {
        forms.add(resolve(path))
      } catch {
        // fichier introuvable : chemin tel quel
      }
    }
    for (const form of forms) if (form !== path) this.aliases.set(form, path)
    return [...forms].map((f) => `(${nodeUrlRegex(f)})`).join('|')
  }

  private async applyBreakpoints(path: string, bps: SourceBreakpoint[]): Promise<BreakpointResult[]> {
    for (const id of this.breakpointIds.get(path) ?? []) await this.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {})
    const ids: string[] = []
    const results: BreakpointResult[] = []
    for (const bp of bps.filter((b) => b.enabled !== false)) {
      try {
        const res = await this.send<{ breakpointId: string; locations: unknown[] }>('Debugger.setBreakpointByUrl', {
          lineNumber: bp.line - 1,
          urlRegex: this.urlRegexFor(path),
          columnNumber: 0,
          condition: bp.condition ?? ''
        })
        ids.push(res.breakpointId)
        results.push({ line: bp.line, verified: true })
      } catch (e) {
        results.push({ line: bp.line, verified: false, message: (e as Error).message })
      }
    }
    this.breakpointIds.set(path, ids)
    return results
  }

  async setBreakpoints(path: string, breakpoints: SourceBreakpoint[]): Promise<BreakpointResult[]> {
    this.wanted.set(path, breakpoints)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return breakpoints.map((b) => ({ line: b.line, verified: true }))
    return this.applyBreakpoints(path, breakpoints)
  }

  async resume(): Promise<void> {
    await this.send('Debugger.resume')
  }
  async stepOver(): Promise<void> {
    await this.send('Debugger.stepOver')
  }
  async stepInto(): Promise<void> {
    await this.send('Debugger.stepInto')
  }
  async stepOut(): Promise<void> {
    await this.send('Debugger.stepOut')
  }
  async pause(): Promise<void> {
    await this.send('Debugger.pause')
  }

  async stackTrace(): Promise<DebugFrame[]> {
    return this.frames.map((f, i) => {
      const url = f.url || this.scripts.get(f.location.scriptId) || ''
      const real = nodeUrlToPath(url, this.windows)
      const path = real && this.aliases.get(real) ? this.aliases.get(real) : real
      return {
        id: i,
        name: f.functionName || '(anonyme)',
        path,
        line: f.location.lineNumber + 1,
        column: (f.location.columnNumber ?? 0) + 1,
        external: !path || /[\\/]node_modules[\\/]/.test(path)
      }
    })
  }

  private ref(objectId: string | undefined): number {
    if (!objectId) return 0
    const id = this.nextRef++
    this.objects.set(id, objectId)
    return id
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    const frame = this.frames[frameId]
    if (!frame) return []
    return frame.scopeChain.map((s) => ({
      name: SCOPE_NAMES[s.type] ?? s.type,
      ref: this.ref(s.object.objectId),
      expensive: s.type === 'global'
    }))
  }

  async variables(ref: number): Promise<DebugVariable[]> {
    const objectId = this.objects.get(ref)
    if (!objectId) return []
    const res = await this.send<{ result: Array<{ name: string; value?: RemoteObject; get?: RemoteObject }> }>('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      generatePreview: false
    })
    return res.result
      .filter((p) => p.value && p.name !== '__proto__')
      .slice(0, 500)
      .map((p) => ({
        name: p.name,
        value: formatRemoteObject(p.value!),
        type: p.value!.subtype ?? p.value!.type,
        ref: p.value!.type === 'object' && p.value!.subtype !== 'null' ? this.ref(p.value!.objectId) : p.value!.type === 'function' ? 0 : 0
      }))
  }

  async evaluate(expression: string, frameId?: number): Promise<{ value: string; ref: number }> {
    const frame = frameId !== undefined ? this.frames[frameId] : undefined
    const res = frame
      ? await this.send<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text: string } }>('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression,
          generatePreview: false
        })
      : await this.send<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text: string } }>('Runtime.evaluate', { expression, replMode: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description?.split('\n')[0] ?? res.exceptionDetails.text)
    return { value: formatRemoteObject(res.result), ref: res.result.type === 'object' && res.result.subtype !== 'null' ? this.ref(res.result.objectId) : 0 }
  }

  async stop(): Promise<void> {
    this.ws?.close()
    if (this.child && this.child.exitCode === null) this.child.kill()
    setTimeout(() => {
      if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL')
      this.finish(null)
    }, 1500)
  }
}
