// Débogueur : types partagés, configurations de lancement (launch.json) et formatage (partagé et testé).

export type DebugType = 'node' | 'python'

export interface DebugConfig {
  name: string
  type: DebugType
  /** Fichier à exécuter (variables ${file}, ${workspaceFolder}… déjà remplacées par l'appelant). */
  program: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stopOnEntry: boolean
  /** Exécutable (node ou python) ; vide = recherche automatique. */
  runtime?: string
  /** Python : n'arrêter que dans le code du projet. */
  justMyCode?: boolean
}

export interface SourceBreakpoint {
  line: number
  condition?: string
  enabled?: boolean
}

export interface BreakpointResult {
  line: number
  verified: boolean
  message?: string
}

export interface DebugFrame {
  id: number
  name: string
  /** Chemin absolu du fichier (absent pour le code interne). */
  path?: string
  line: number
  column: number
  /** Code d'une bibliothèque ou interne au moteur. */
  external?: boolean
}

export interface DebugScope {
  name: string
  ref: number
  expensive?: boolean
}

export interface DebugVariable {
  name: string
  value: string
  type?: string
  /** Référence pour développer la valeur (0 : valeur simple). */
  ref: number
}

export type DebugEvent =
  | { type: 'stopped'; reason: string; description?: string; threadId?: number }
  | { type: 'continued' }
  | { type: 'output'; category: 'stdout' | 'stderr' | 'console' | 'info'; text: string }
  | { type: 'terminated'; exitCode?: number | null }

/** Configuration telle qu'écrite dans .vscode/launch.json (sous-ensemble utile). */
export interface LaunchEntry {
  name: string
  type: string
  request?: string
  program?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  stopOnEntry?: boolean
  runtimeExecutable?: string
  python?: string
  justMyCode?: boolean
}

/** Retire les commentaires et virgules finales du JSON « avec commentaires » de VS Code. */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const TYPE_ALIASES: Record<string, DebugType> = { node: 'node', 'pwa-node': 'node', python: 'python', debugpy: 'python' }

/** Configurations de lancement prises en charge (Node.js et Python, requête « launch »). */
export function parseLaunchJson(text: string): LaunchEntry[] {
  try {
    const data = JSON.parse(stripJsonc(text)) as { configurations?: unknown }
    if (!Array.isArray(data.configurations)) return []
    return data.configurations.filter(
      (c): c is LaunchEntry =>
        !!c && typeof c === 'object' && typeof (c as LaunchEntry).name === 'string' && (c as LaunchEntry).type in TYPE_ALIASES && ((c as LaunchEntry).request ?? 'launch') === 'launch'
    )
  } catch {
    return []
  }
}

export interface VariableContext {
  workspaceFolder: string
  file: string | null
  env?: Record<string, string | undefined>
}

/** Remplace les variables de VS Code : ${workspaceFolder}, ${file}, ${fileDirname}, ${env:NOM}… */
export function substituteVariables(value: string, ctx: VariableContext): string {
  const sep = ctx.workspaceFolder.includes('\\') && !ctx.workspaceFolder.includes('/') ? '\\' : '/'
  const file = ctx.file ?? ''
  const base = file.split(/[\\/]/).pop() ?? ''
  const dir = file.slice(0, Math.max(0, file.length - base.length - 1))
  const rel = file.startsWith(ctx.workspaceFolder) ? file.slice(ctx.workspaceFolder.length + 1) : file
  const vars: Record<string, string> = {
    workspaceFolder: ctx.workspaceFolder,
    workspaceRoot: ctx.workspaceFolder,
    workspaceFolderBasename: ctx.workspaceFolder.split(/[\\/]/).pop() ?? '',
    file,
    fileBasename: base,
    fileBasenameNoExtension: base.replace(/\.[^.]*$/, ''),
    fileDirname: dir,
    fileExtname: base.includes('.') ? base.slice(base.lastIndexOf('.')) : '',
    relativeFile: rel,
    pathSeparator: sep,
    '/': sep
  }
  return value.replace(/\$\{([^}]+)\}/g, (m, name: string) => {
    if (name.startsWith('env:')) return ctx.env?.[name.slice(4)] ?? ''
    return vars[name] ?? m
  })
}

/** Convertit une entrée de launch.json en configuration exécutable. */
export function resolveLaunchEntry(entry: LaunchEntry, ctx: VariableContext): DebugConfig | { error: string } {
  const type = TYPE_ALIASES[entry.type]
  const sub = (v: string) => substituteVariables(v, ctx)
  if (!entry.program) return { error: `La configuration « ${entry.name} » n’indique pas de programme (« program »).` }
  const program = sub(entry.program)
  if (program.includes('${')) return { error: `Variable non prise en charge dans « ${entry.program} ».` }
  if (!program) return { error: 'Aucun fichier actif à déboguer.' }
  return {
    name: entry.name,
    type,
    program,
    args: (entry.args ?? []).map(sub),
    cwd: entry.cwd ? sub(entry.cwd) : ctx.workspaceFolder,
    env: Object.fromEntries(Object.entries(entry.env ?? {}).map(([k, v]) => [k, sub(String(v))])),
    stopOnEntry: !!entry.stopOnEntry,
    runtime: entry.runtimeExecutable ?? entry.python,
    justMyCode: entry.justMyCode ?? true
  }
}

/** Type de débogage déduit de l'extension du fichier. */
export function debugTypeForFile(path: string): DebugType | null {
  if (/\.(c|m)?js$/i.test(path)) return 'node'
  if (/\.py$/i.test(path)) return 'python'
  return null
}

/** Configuration par défaut : exécuter le fichier actif. */
export function defaultConfig(path: string, workspace: string): DebugConfig | null {
  const type = debugTypeForFile(path)
  if (!type) return null
  return {
    name: `${type === 'node' ? 'Node.js' : 'Python'} : fichier actif`,
    type,
    program: path,
    args: [],
    cwd: workspace,
    env: {},
    stopOnEntry: false,
    justMyCode: true
  }
}

/** Expression régulière qui reconnaît l'URL d'un script Node pour un chemin de fichier. */
export function nodeUrlRegex(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // CommonJS (chemin brut) ou ESM (file:///…), lettre de lecteur Windows insensible à la casse.
  const drive = /^[a-zA-Z]:/.test(norm) ? `[${norm[0].toLowerCase()}${norm[0].toUpperCase()}]${escaped.slice(1)}` : escaped
  const body = drive.replace(/^\//, '').split('/').join('[\\\\/]')
  return `^(file://)?/?${body}$`
}

/** Chemin de fichier à partir d'une URL de script Node. */
export function nodeUrlToPath(url: string, windows = false): string | undefined {
  if (!url || url.startsWith('node:') || url.startsWith('internal/')) return undefined
  if (url.startsWith('file://')) {
    const decoded = decodeURIComponent(url.slice('file://'.length))
    return windows ? decoded.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\') : decoded
  }
  return /^([a-zA-Z]:)?[\\/]/.test(url) ? url : undefined
}

interface RemoteObjectLike {
  type: string
  subtype?: string
  className?: string
  value?: unknown
  unserializableValue?: string
  description?: string
}

/** Affichage d'une valeur du protocole d'inspection de V8. */
export function formatRemoteObject(o: RemoteObjectLike): string {
  if (o.unserializableValue) return o.unserializableValue
  switch (o.type) {
    case 'undefined':
      return 'undefined'
    case 'string':
      return JSON.stringify(o.value)
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(o.value ?? o.description)
    case 'symbol':
      return o.description ?? 'Symbol()'
    case 'function':
      return `ƒ ${(o.description ?? '').split('\n')[0].replace(/^function\s*/, '').replace(/\{.*$/, '').trim() || 'anonyme'}`
    case 'object':
      if (o.subtype === 'null') return 'null'
      return o.description ?? o.className ?? 'Object'
    default:
      return o.description ?? String(o.value)
  }
}

/** Messages de Node à ne pas afficher dans la console de débogage. */
export function isInspectorNoise(line: string): boolean {
  return /^(Debugger listening on |For help, see: https:\/\/nodejs\.org|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)/.test(line.trim())
}
