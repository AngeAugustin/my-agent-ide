import { create } from 'zustand'
import {
  debugTypeForFile,
  defaultConfig,
  parseLaunchJson,
  resolveLaunchEntry,
  type DebugEvent,
  type DebugFrame,
  type DebugScope,
  type DebugVariable,
  type LaunchEntry,
  type SourceBreakpoint
} from '@shared/debug'
import { basename, join } from '../lib/paths'
import { notify, openFile, reportError, saveAll, showSidebarView, togglePanel, useIde } from './ide'
import { registerDebugContextProvider } from './chat'

export interface ConsoleEntry {
  id: number
  kind: 'stdout' | 'stderr' | 'console' | 'info' | 'input' | 'result' | 'error'
  text: string
  ref?: number
}

export interface WatchValue {
  value?: string
  ref?: number
  error?: string
}

interface DebugState {
  breakpoints: Record<string, SourceBreakpoint[]>
  session: { id: number; name: string; status: 'starting' | 'running' | 'paused' | 'terminated'; reason?: string; description?: string } | null
  frames: DebugFrame[]
  frameId: number | null
  scopes: DebugScope[]
  /** Enfants chargés, par référence (vidé à chaque reprise). */
  children: Record<number, DebugVariable[]>
  expanded: Record<string, boolean>
  watches: string[]
  watchValues: Record<string, WatchValue>
  console: ConsoleEntry[]
  configs: LaunchEntry[]
  /** Nom de la configuration choisie ('' : fichier actif). */
  selected: string
  panelTab: 'terminal' | 'debug' | 'problems'
  /** Point d'arrêt dont la condition est en cours de modification. */
  editing: { path: string; line: number } | null
}

export const useDebug = create<DebugState>()(() => ({
  breakpoints: {},
  session: null,
  frames: [],
  frameId: null,
  scopes: [],
  children: {},
  expanded: {},
  watches: [],
  watchValues: {},
  console: [],
  configs: [],
  selected: '',
  panelTab: 'terminal',
  editing: null
}))

/** Message d'erreur lisible (sans préfixe IPC, dernière ligne d'une trace Python). */
function cleanError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  if (/Traceback \(most recent call last\)/.test(msg)) {
    const lines = msg.trim().split('\n').filter((l) => l.trim())
    return lines[lines.length - 1].trim()
  }
  return msg
}

const set = useDebug.setState
const get = useDebug.getState
let consoleId = 0
const MAX_CONSOLE = 5000

function log(kind: ConsoleEntry['kind'], text: string, ref?: number): void {
  set((s) => {
    const last = s.console[s.console.length - 1]
    // Les morceaux de sortie d'un même flux sont regroupés tant que la ligne n'est pas finie.
    if (last && last.kind === kind && (kind === 'stdout' || kind === 'stderr') && !last.text.endsWith('\n')) {
      return { console: [...s.console.slice(0, -1), { ...last, text: last.text + text }] }
    }
    const next = [...s.console, { id: ++consoleId, kind, text, ref }]
    return { console: next.length > MAX_CONSOLE ? next.slice(-MAX_CONSOLE) : next }
  })
}

// ---------------------------------------------------------------------------
// Points d'arrêt (mémorisés par dossier de travail)
// ---------------------------------------------------------------------------

const storageKey = () => `debug:${useIde.getState().workspace ?? ''}`

function persist(): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ breakpoints: get().breakpoints, watches: get().watches, selected: get().selected }))
  } catch {
    // stockage indisponible
  }
}

function restore(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey()) ?? '{}') as Partial<Pick<DebugState, 'breakpoints' | 'watches' | 'selected'>>
    set({ breakpoints: raw.breakpoints ?? {}, watches: raw.watches ?? [], selected: raw.selected ?? '' })
  } catch {
    set({ breakpoints: {}, watches: [], selected: '' })
  }
}

async function pushBreakpoints(path: string): Promise<void> {
  const session = get().session
  if (!session || session.status === 'terminated') return
  try {
    await window.api.debug.setBreakpoints(session.id, path, get().breakpoints[path] ?? [])
  } catch (err) {
    reportError('Point d’arrêt non appliqué', err)
  }
}

export function setBreakpoints(path: string, bps: SourceBreakpoint[]): void {
  set((s) => {
    const next = { ...s.breakpoints }
    if (bps.length) next[path] = [...bps].sort((a, b) => a.line - b.line)
    else delete next[path]
    return { breakpoints: next }
  })
  persist()
  void pushBreakpoints(path)
}

export function toggleBreakpoint(path: string, line: number): void {
  const current = get().breakpoints[path] ?? []
  setBreakpoints(path, current.some((b) => b.line === line) ? current.filter((b) => b.line !== line) : [...current, { line }])
}

export function setBreakpointCondition(path: string, line: number, condition: string): void {
  const current = get().breakpoints[path] ?? []
  setBreakpoints(
    path,
    current.some((b) => b.line === line)
      ? current.map((b) => (b.line === line ? { ...b, condition: condition.trim() || undefined } : b))
      : [...current, { line, condition: condition.trim() || undefined }]
  )
}

export function editCondition(path: string, line: number | null): void {
  set({ editing: line === null ? null : { path, line } })
  if (line !== null) showSidebarView('debug')
}

export function toggleBreakpointEnabled(path: string, line: number): void {
  setBreakpoints(path, (get().breakpoints[path] ?? []).map((b) => (b.line === line ? { ...b, enabled: b.enabled === false } : b)))
}

export function removeAllBreakpoints(): void {
  const paths = Object.keys(get().breakpoints)
  set({ breakpoints: {} })
  persist()
  paths.forEach((p) => void pushBreakpoints(p))
}

/** Point d'arrêt au curseur de l'éditeur actif (F9). */
export function toggleBreakpointAtCursor(): void {
  const { activeId, cursor } = useIde.getState()
  if (!activeId || activeId.startsWith('ide://') || activeId.startsWith('untitled:') || !cursor) return
  toggleBreakpoint(activeId, cursor.line)
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

export async function loadLaunchConfigs(): Promise<void> {
  const ws = useIde.getState().workspace
  if (!ws) return set({ configs: [] })
  try {
    const text = await window.api.fs.readFile(join(join(ws, '.vscode'), 'launch.json'))
    set({ configs: parseLaunchJson(text) })
  } catch {
    set({ configs: [] })
  }
}

export function selectConfig(name: string): void {
  set({ selected: name })
  persist()
}

/** Ouvre (ou crée) .vscode/launch.json. */
export async function openLaunchJson(): Promise<void> {
  const ws = useIde.getState().workspace
  if (!ws) return notify('Ouvrez un dossier pour configurer le débogage.', 'info')
  const path = join(join(ws, '.vscode'), 'launch.json')
  if (!(await window.api.fs.exists(path))) {
    await window.api.fs.createDir(join(ws, '.vscode')).catch(() => {})
    await window.api.fs.writeFile(
      path,
      `{
  // Configurations de débogage (format de VS Code). Types pris en charge : node, python.
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Node.js : programme",
      "program": "\${workspaceFolder}/index.js",
      "args": [],
      "cwd": "\${workspaceFolder}"
    },
    {
      "type": "python",
      "request": "launch",
      "name": "Python : fichier actif",
      "program": "\${file}",
      "justMyCode": true
    }
  ]
}
`
    )
  }
  await openFile(path)
  void loadLaunchConfigs()
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const isDebugging = () => {
  const s = get().session
  return !!s && s.status !== 'terminated'
}
export const isPaused = () => get().session?.status === 'paused'

function activeFile(): string | null {
  const id = useIde.getState().activeId
  return id && !id.startsWith('ide://') && !id.startsWith('untitled:') ? id : null
}

export async function startDebugging(): Promise<void> {
  if (isDebugging()) {
    if (isPaused()) return resume()
    return
  }
  const ws = useIde.getState().workspace
  if (!ws) return notify('Ouvrez un dossier pour déboguer.', 'info')
  await loadLaunchConfigs()
  const { selected, configs } = get()
  const file = activeFile()
  const entry = configs.find((c) => c.name === selected)
  let config
  if (entry) {
    const resolved = resolveLaunchEntry(entry, { workspaceFolder: ws, file, env: {} })
    if ('error' in resolved) return notify(resolved.error, 'error')
    config = resolved
  } else {
    if (!file || !debugTypeForFile(file)) {
      return notify('Ouvrez un fichier JavaScript ou Python à déboguer, ou créez une configuration dans .vscode/launch.json.', 'info')
    }
    config = defaultConfig(file, ws)!
  }
  // Le programme doit tourner avec le contenu enregistré.
  await saveAll()
  set({ session: { id: -1, name: config.name, status: 'starting' }, frames: [], frameId: null, scopes: [], children: {}, console: [], panelTab: 'debug' })
  togglePanel(true)
  showSidebarView('debug')
  log('info', `Démarrage : ${config.name} (${basename(config.program)})\n`)
  try {
    const breakpoints = Object.fromEntries(Object.entries(get().breakpoints).filter(([path]) => debugTypeForFile(path) === config.type))
    const id = await window.api.debug.start(config, breakpoints)
    set((s) => (s.session && s.session.status === 'starting' ? { session: { ...s.session, id, status: s.session.status === 'starting' ? 'running' : s.session.status } } : {}))
    // Les événements reçus avant la fin du démarrage portent déjà cet identifiant.
    flushEarly(id)
  } catch (err) {
    set({ session: null })
    log('error', `${cleanError(err)}\n`)
    reportError('Débogage impossible', err)
  }
}

const early: Array<[number, DebugEvent]> = []

function flushEarly(id: number): void {
  const events = early.splice(0).filter(([sid]) => sid === id)
  events.forEach(([, e]) => onEvent(id, e))
}

function sessionId(): number | null {
  const s = get().session
  return s && s.id >= 0 && s.status !== 'terminated' ? s.id : null
}

async function control(action: 'resume' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause'): Promise<void> {
  const id = sessionId()
  if (id === null) return
  try {
    await window.api.debug[action](id)
  } catch (err) {
    reportError('Commande de débogage impossible', err)
  }
}

export const resume = () => control('resume')
export const stepOver = () => control('stepOver')
export const stepInto = () => control('stepInto')
export const stepOut = () => control('stepOut')
export const pause = () => control('pause')

export async function stopDebugging(): Promise<void> {
  const id = sessionId()
  if (id === null) {
    if (get().session?.status === 'starting') set({ session: null })
    return
  }
  set((s) => ({ session: s.session ? { ...s.session, status: 'terminated' } : null, frames: [], frameId: null, scopes: [] }))
  await window.api.debug.stop(id).catch(() => {})
}

export async function restartDebugging(): Promise<void> {
  await stopDebugging()
  await startDebugging()
}

async function onStopped(id: number, reason: string, description?: string): Promise<void> {
  set((s) => ({ session: s.session ? { ...s.session, status: 'paused', reason, description } : null, children: {}, watchValues: {} }))
  try {
    const frames = await window.api.debug.stackTrace(id)
    set({ frames })
    const target = frames.find((f) => f.path && !f.external) ?? frames[0]
    if (target) await selectFrame(target.id, true)
    if (reason === 'exception') log('error', `Exception${description ? ` : ${description}` : ''}\n`)
  } catch (err) {
    reportError('Lecture de la pile impossible', err)
  }
}

/** Sélectionne une ligne de la pile : ouvre le fichier et charge ses variables. */
export async function selectFrame(frameId: number, reveal = true): Promise<void> {
  const id = sessionId()
  const frame = get().frames.find((f) => f.id === frameId)
  if (id === null || !frame) return
  set({ frameId, scopes: [] })
  if (reveal && frame.path) void openFile(frame.path, { line: frame.line, column: frame.column, preview: true })
  try {
    const scopes = await window.api.debug.scopes(id, frameId)
    set({ scopes })
    const first = scopes.find((s) => !s.expensive)
    if (first) {
      set((s) => ({ expanded: { ...s.expanded, [`scope:${first.name}`]: s.expanded[`scope:${first.name}`] ?? true } }))
      for (const s of scopes) if (!s.expensive && get().expanded[`scope:${s.name}`]) await loadChildren(s.ref)
    }
    await refreshWatches()
  } catch (err) {
    reportError('Lecture des variables impossible', err)
  }
}

export async function loadChildren(ref: number): Promise<void> {
  const id = sessionId()
  if (id === null || ref === 0 || get().children[ref]) return
  const vars = await window.api.debug.variables(id, ref)
  set((s) => ({ children: { ...s.children, [ref]: vars } }))
}

export function toggleExpanded(key: string, ref: number): void {
  const open = !get().expanded[key]
  set((s) => ({ expanded: { ...s.expanded, [key]: open } }))
  if (open) void loadChildren(ref).catch((err) => reportError('Lecture impossible', err))
}

// ---------------------------------------------------------------------------
// Console et expressions espionnées
// ---------------------------------------------------------------------------

export async function evaluateInConsole(expression: string): Promise<void> {
  const expr = expression.trim()
  if (!expr) return
  log('input', `${expr}\n`)
  const id = sessionId()
  if (id === null) return log('error', 'Aucune session de débogage en cours.\n')
  try {
    const res = await window.api.debug.evaluate(id, expr, get().frameId ?? undefined)
    log('result', res.value, res.ref)
  } catch (err) {
    log('error', `${cleanError(err)}\n`)
  }
}

export function clearConsole(): void {
  set({ console: [] })
}

export function addWatch(expression: string): void {
  const expr = expression.trim()
  if (!expr || get().watches.includes(expr)) return
  set((s) => ({ watches: [...s.watches, expr] }))
  persist()
  void refreshWatches()
}

export function removeWatch(expression: string): void {
  set((s) => ({ watches: s.watches.filter((w) => w !== expression) }))
  persist()
}

async function refreshWatches(): Promise<void> {
  const id = sessionId()
  if (id === null || !isPaused()) return
  const values: Record<string, WatchValue> = {}
  for (const w of get().watches) {
    try {
      const r = await window.api.debug.evaluate(id, w, get().frameId ?? undefined)
      values[w] = { value: r.value, ref: r.ref }
    } catch (err) {
      values[w] = { error: cleanError(err) }
    }
  }
  set({ watchValues: values })
}

export function setPanelTab(tab: 'terminal' | 'debug' | 'problems'): void {
  set({ panelTab: tab })
}

/** Ligne en cours d'exécution (cadre sélectionné) pour la mise en évidence dans l'éditeur. */
export function currentLocation(): { path: string; line: number; top: boolean } | null {
  const { session, frames, frameId } = get()
  if (session?.status !== 'paused') return null
  const frame = frames.find((f) => f.id === frameId)
  if (!frame?.path) return null
  return { path: frame.path, line: frame.line, top: frame.id === frames[0]?.id }
}

/** Résumé de l'état du débogueur pour l'IA (@debug). */
export async function debugContextText(): Promise<string> {
  const { session, frames, scopes, children } = get()
  if (!session || session.status !== 'paused') return 'Aucun programme n’est en pause dans le débogueur.'
  const lines = [`Programme en pause (${session.reason ?? 'pause'}${session.description ? ` : ${session.description}` : ''}).`, '', 'Pile d’appels :']
  for (const f of frames.slice(0, 20)) lines.push(`- ${f.name} — ${f.path ?? '(interne)'}:${f.line}`)
  for (const s of scopes.filter((x) => !x.expensive)) {
    lines.push('', `Variables (${s.name}) :`)
    for (const v of (children[s.ref] ?? []).slice(0, 60)) lines.push(`- ${v.name} = ${v.value.slice(0, 300)}`)
  }
  return lines.join('\n')
}

function onEvent(id: number, event: DebugEvent): void {
  const session = get().session
  if (!session) return
  if (session.id !== id) {
    // Événement arrivé avant que l'interface ne connaisse l'identifiant de la session.
    if (session.status === 'starting') early.push([id, event])
    return
  }
  switch (event.type) {
    case 'output':
      log(event.category, event.text)
      break
    case 'stopped':
      void onStopped(id, event.reason, event.description)
      break
    case 'continued':
      set((s) => ({ session: s.session ? { ...s.session, status: 'running', reason: undefined, description: undefined } : null, frames: [], frameId: null, scopes: [], children: {} }))
      break
    case 'terminated':
      log('info', `Fin du programme${event.exitCode !== undefined && event.exitCode !== null ? ` (code ${event.exitCode})` : ''}.\n`)
      set((s) => ({ session: s.session ? { ...s.session, status: 'terminated' } : null, frames: [], frameId: null, scopes: [], children: {} }))
      break
  }
}

let initialized = false

export function initDebug(): void {
  if (initialized) return
  initialized = true
  registerDebugContextProvider(() => get().session?.status === 'paused')
  window.api.debug.onEvent(onEvent)
  restore()
  void loadLaunchConfigs()
  useIde.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace) {
      void stopDebugging()
      restore()
      void loadLaunchConfigs()
    }
  })
  window.api.fs.onChange((events) => {
    if (events.some((e) => /[\\/]\.vscode[\\/]launch\.json$/.test(e.path))) void loadLaunchConfigs()
  })
}
