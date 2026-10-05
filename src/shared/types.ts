// Types partagés entre le processus principal, le preload et l'interface.

import {
  DEFAULT_AI_SETTINGS,
  type AiSettings,
  type ChatEvent,
  type ChatRequest,
  type KeyStorageInfo,
  type ModelInfo,
  type ProviderStatus,
  type ProviderTestResult,
  type UsageEntry
} from './ai'

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  include?: string
  exclude?: string
}

export interface SearchMatch {
  line: number
  column: number
  length: number
  preview: string
}

export interface SearchFileResult {
  path: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFileResult[]
  totalMatches: number
  truncated: boolean
}

export type ThemeName = 'dark' | 'light'
export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange'

export interface Settings {
  theme: ThemeName
  editorFontSize: number
  editorFontFamily: string
  tabSize: number
  insertSpaces: boolean
  wordWrap: boolean
  minimap: boolean
  lineNumbers: boolean
  renderWhitespace: boolean
  autoSave: AutoSaveMode
  autoSaveDelay: number
  terminalFontSize: number
  terminalShell: string
  showReasoning: boolean
  excludedFolders: string[]
  ai: AiSettings
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  editorFontSize: 14,
  editorFontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
  tabSize: 2,
  insertSpaces: true,
  wordWrap: false,
  minimap: true,
  lineNumbers: true,
  renderWhitespace: false,
  autoSave: 'off',
  autoSaveDelay: 1000,
  terminalFontSize: 13,
  terminalShell: '',
  showReasoning: true,
  excludedFolders: ['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', '__pycache__'],
  ai: DEFAULT_AI_SETTINGS
}

export interface SessionState {
  workspace: string | null
  openFiles: string[]
  activeFile: string | null
  recentWorkspaces: string[]
}

export const DEFAULT_SESSION: SessionState = {
  workspace: null,
  openFiles: [],
  activeFile: null,
  recentWorkspaces: []
}

export interface FsChangeEvent {
  type: 'change' | 'rename'
  path: string
}

/** API exposée à l'interface via `window.api`. */
export interface IdeApi {
  platform: string
  homeDir: string
  fs: {
    readDir(path: string): Promise<FileEntry[]>
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    createFile(path: string): Promise<void>
    createDir(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    trash(path: string): Promise<void>
    exists(path: string): Promise<boolean>
    listFiles(root: string): Promise<string[]>
    watch(root: string): Promise<void>
    onChange(cb: (events: FsChangeEvent[]) => void): () => void
  }
  search: {
    text(root: string, query: string, options: SearchOptions): Promise<SearchResult>
  }
  dialog: {
    openFolder(): Promise<string | null>
    openFile(): Promise<string | null>
    saveFile(defaultPath?: string): Promise<string | null>
  }
  shell: {
    revealInFolder(path: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
  terminal: {
    create(cwd: string | null, cols: number, rows: number): Promise<number>
    write(id: number, data: string): void
    resize(id: number, cols: number, rows: number): void
    kill(id: number): void
    onData(cb: (id: number, data: string) => void): () => void
    onExit(cb: (id: number, code: number) => void): () => void
  }
  ai: {
    providers(): Promise<{ providers: ProviderStatus[]; storage: KeyStorageInfo }>
    setKey(providerId: string, key: string): Promise<void>
    deleteKey(providerId: string): Promise<void>
    test(providerId: string): Promise<ProviderTestResult>
    models(providerId: string, refresh?: boolean): Promise<ModelInfo[]>
    usage(): Promise<Record<string, UsageEntry>>
    resetUsage(): Promise<void>
    chat(requestId: string, request: ChatRequest): Promise<void>
    abort(requestId: string): void
    onEvent(cb: (requestId: string, event: ChatEvent) => void): () => void
  }
  chats: {
    load(workspace: string | null): Promise<unknown>
    save(workspace: string | null, data: unknown): Promise<void>
  }
  git: {
    diff(cwd: string): Promise<string>
  }
  settings: {
    get(): Promise<Settings>
    set(settings: Settings): Promise<void>
  }
  session: {
    get(): Promise<SessionState>
    set(session: SessionState): Promise<void>
  }
  app: {
    onMenuCommand(cb: (command: string) => void): () => void
    onBeforeClose(cb: () => void): () => void
    confirmClose(): void
    setTitle(title: string): void
  }
}
