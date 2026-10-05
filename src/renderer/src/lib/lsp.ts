import { create } from 'zustand'
import { acceptsUri, type LspServerStatus } from '@shared/lsp'
import { monaco } from './monaco'
import { openFile, useIde } from '../store/ide'

type Json = Record<string, any>
type ConnectionState = { state: 'connecting' } | { state: 'open' } | { state: 'closed'; error: Error | undefined }

export const useLsp = create<{ servers: LspServerStatus[]; running: Record<string, 'starting' | 'running' | 'error'> }>()(() => ({
  servers: [],
  running: {}
}))

const LOCATION_METHODS = new Set([
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/references'
])

/** Crée (sans l'ouvrir dans un onglet) le modèle d'un fichier cité par le serveur, pour la navigation. */
async function ensureModels(result: unknown): Promise<void> {
  const items = Array.isArray(result) ? result : result ? [result] : []
  for (const item of items as Json[]) {
    const uri: string | undefined = item?.targetUri ?? item?.uri
    if (!uri?.startsWith('file:')) continue
    const parsed = monaco.Uri.parse(uri)
    if (monaco.editor.getModel(parsed)) continue
    try {
      const content = await window.api.fs.readFile(parsed.fsPath)
      if (!monaco.editor.getModel(parsed)) monaco.editor.createModel(content, undefined, parsed)
    } catch {
      // fichier illisible : la navigation échouera simplement
    }
  }
}

/**
 * Transport entre le client LSP de Monaco et un serveur lancé par le processus principal.
 * Il filtre les documents (seules les extensions du serveur), indique la racine du projet
 * et permet de redémarrer le serveur sans recréer le client (changement de dossier, plantage).
 */
class IpcTransport {
  private listener: ((m: Json) => void) | undefined
  private pending: Json[] = []
  private session: number | null = null
  private initializeMessage: Json | null = null
  private initializedSent = false
  private readonly methods = new Map<number | string, string>()
  private readonly swallow = new Set<number | string>()
  private readonly open = new Set<string>()
  private connectionState: ConnectionState = { state: 'connecting' }
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()
  private outbox: Json[] = []
  private root: { rootUri: string; tsserverPath: string | null } | null = null

  /** État de connexion attendu par le client LSP de Monaco (valeur + événement de changement). */
  readonly state: { readonly value: ConnectionState; onChange: (listener: (s: ConnectionState) => void) => { dispose(): void } }

  constructor(private readonly serverId: string, private readonly extensions: string[]) {
    const self = this
    this.state = {
      get value() {
        return self.connectionState
      },
      onChange: (listener) => {
        self.stateListeners.add(listener)
        return { dispose: () => self.stateListeners.delete(listener) }
      }
    }
    window.api.lsp.onMessage((id, message) => {
      if (id === this.session) void this.receive(message as Json)
    })
    window.api.lsp.onExit((id) => {
      if (id !== this.session) return
      this.session = null
      useLsp.setState((s) => ({ running: { ...s.running, [this.serverId]: 'error' } }))
    })
  }

  private setState(state: ConnectionState): void {
    this.connectionState = state
    this.stateListeners.forEach((l) => l(state))
  }

  private deliver(message: Json): void {
    if (this.listener) this.listener(message)
    else this.pending.push(message)
  }

  private async receive(message: Json): Promise<void> {
    if (message.id !== undefined && message.method === undefined) {
      if (this.swallow.delete(message.id)) return
      const method = this.methods.get(message.id)
      this.methods.delete(message.id)
      if (method && LOCATION_METHODS.has(method)) await ensureModels(message.result)
    }
    this.deliver(message)
  }

  /** Démarre (ou redémarre) le serveur pour un projet. */
  async start(root: string): Promise<void> {
    if (this.session !== null) await window.api.lsp.stop(this.session)
    this.session = null
    useLsp.setState((s) => ({ running: { ...s.running, [this.serverId]: 'starting' } }))
    try {
      const res = await window.api.lsp.start(this.serverId, root)
      this.session = res.id
      this.root = { rootUri: res.rootUri, tsserverPath: res.tsserverPath }
      useLsp.setState((s) => ({ running: { ...s.running, [this.serverId]: 'running' } }))
    } catch {
      useLsp.setState((s) => ({ running: { ...s.running, [this.serverId]: 'error' } }))
      return
    }
    if (this.initializeMessage) {
      // Redémarrage : on rejoue l'initialisation (réponse ignorée) puis on rouvre les documents.
      const replay = { ...this.withRoot(this.initializeMessage), id: `replay-${Date.now()}` }
      this.swallow.add(replay.id)
      this.forward(replay)
      if (this.initializedSent) this.forward({ jsonrpc: '2.0', method: 'initialized', params: {} })
      for (const uri of this.open) {
        const model = monaco.editor.getModel(monaco.Uri.parse(uri))
        if (!model) continue
        this.forward({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: { textDocument: { uri, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() } }
        })
      }
    }
    const queued = this.outbox
    this.outbox = []
    queued.forEach((m) => this.forward(m))
    this.setState({ state: 'open' })
  }

  private withRoot(message: Json): Json {
    if (!this.root) return message
    const params = { ...(message.params ?? {}) }
    params.rootUri = this.root.rootUri
    params.rootPath = decodeURIComponent(this.root.rootUri.replace(/^file:\/\//, ''))
    params.workspaceFolders = [{ uri: this.root.rootUri, name: this.root.rootUri.split('/').pop() }]
    if (this.serverId === 'typescript' && this.root.tsserverPath) {
      params.initializationOptions = {
        ...(params.initializationOptions ?? {}),
        tsserver: { fallbackPath: this.root.tsserverPath },
        preferences: { includeCompletionsForModuleExports: true, includeInlayParameterNameHints: 'none' }
      }
    }
    return { ...message, params }
  }

  private forward(message: Json): void {
    if (this.session === null) {
      this.outbox.push(message)
      return
    }
    window.api.lsp.send(this.session, message)
  }

  async send(message: Json): Promise<void> {
    if (message.method === 'initialize') {
      this.initializeMessage = message
      message = this.withRoot(message)
    }
    if (message.method === 'initialized') this.initializedSent = true
    const uri: string | undefined = message.params?.textDocument?.uri
    if (uri && !acceptsUri(this.extensions, uri)) {
      // Document d'un autre langage ou modèle temporaire : jamais envoyé à ce serveur.
      if (message.id !== undefined && message.method) this.deliver({ jsonrpc: '2.0', id: message.id, result: null })
      return
    }
    if (uri && message.method === 'textDocument/didOpen') this.open.add(uri)
    if (uri && message.method === 'textDocument/didClose') this.open.delete(uri)
    if (message.id !== undefined && message.method) this.methods.set(message.id, message.method)
    this.forward(message)
  }

  setListener(listener: ((m: Json) => void) | undefined): void {
    this.listener = listener
    if (listener) {
      const queued = this.pending
      this.pending = []
      queued.forEach((m) => listener(m))
    }
  }

  toString(): string {
    return `lsp:${this.serverId}`
  }

  async stop(): Promise<void> {
    if (this.session !== null) await window.api.lsp.stop(this.session)
    this.session = null
    useLsp.setState((s) => {
      const running = { ...s.running }
      delete running[this.serverId]
      return { running }
    })
  }

  get running(): boolean {
    return this.session !== null
  }
}

const transports = new Map<string, IpcTransport>()
let currentRoot: string | null = null
let tsBuiltinDisabled = false

/** Coupe les fonctions intégrées de Monaco pour TS/JS quand le vrai serveur prend le relais (évite les doublons). */
function disableBuiltinTypeScript(): void {
  if (tsBuiltinDisabled) return
  tsBuiltinDisabled = true
  const off = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false
  }
  monaco.typescript.typescriptDefaults.setModeConfiguration(off)
  monaco.typescript.javascriptDefaults.setModeConfiguration(off)
}

async function ensureServer(serverId: string): Promise<void> {
  const root = currentRoot
  if (!root) return
  const status = useLsp.getState().servers.find((s) => s.id === serverId)
  if (!status?.available || !status.enabled) return
  let transport = transports.get(serverId)
  if (transport?.running) return
  if (!transport) {
    transport = new IpcTransport(serverId, status.extensions)
    transports.set(serverId, transport)
    await transport.start(root)
    if (!transport.running) return
    if (serverId === 'typescript') disableBuiltinTypeScript()
    new monaco.lsp.MonacoLspClient(transport as never)
    return
  }
  await transport.start(root)
}

function serverFor(uri: monaco.Uri): string | null {
  if (uri.scheme !== 'file') return null
  const s = useLsp.getState().servers.find((srv) => srv.enabled && srv.available && acceptsUri(srv.extensions, uri.toString()))
  return s?.id ?? null
}

/** Rafraîchit la liste des serveurs et démarre ceux dont un fichier est ouvert. */
export async function refreshLsp(): Promise<void> {
  const root = useIde.getState().workspace
  const rootChanged = root !== currentRoot
  currentRoot = root
  const servers = await window.api.lsp.servers(root)
  useLsp.setState({ servers })
  if (!root) return
  for (const [id, t] of transports) {
    const enabled = servers.find((s) => s.id === id)?.enabled
    if (!enabled) await t.stop()
    else if (rootChanged || !t.running) await t.start(root)
  }
  for (const model of monaco.editor.getModels()) {
    const id = serverFor(model.uri)
    if (id) await ensureServer(id)
  }
}

let initialized = false

export function initLsp(): void {
  if (initialized) return
  initialized = true
  // Navigation (Ctrl+clic, F12) vers un autre fichier : ouverture dans un onglet.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      if (resource.scheme !== 'file') return false
      const pos = selection && 'startLineNumber' in selection ? { line: selection.startLineNumber, column: selection.startColumn } : selection && 'lineNumber' in selection ? { line: selection.lineNumber, column: selection.column } : undefined
      void openFile(resource.fsPath, { preview: true, ...(pos ?? {}) })
      return true
    }
  })
  monaco.editor.onDidCreateModel((model) => {
    const id = serverFor(model.uri)
    if (id) void ensureServer(id)
  })
  void refreshLsp()
  useIde.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace || s.settings.lsp !== prev.settings.lsp) setTimeout(() => void refreshLsp(), 100)
  })
}

