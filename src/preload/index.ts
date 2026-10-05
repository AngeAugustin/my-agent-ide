import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ChatEvent } from '@shared/ai'
import type { IndexStatus } from '@shared/codeindex'
import type { McpServerStatus } from '@shared/mcp'
import type { FsChangeEvent, IdeApi } from '@shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: IdeApi = {
  platform: process.platform,
  homeDir: process.env.HOME || process.env.USERPROFILE || '',
  fs: {
    readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
    readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
    createFile: (path) => ipcRenderer.invoke('fs:createFile', path),
    createDir: (path) => ipcRenderer.invoke('fs:createDir', path),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
    trash: (path) => ipcRenderer.invoke('fs:trash', path),
    exists: (path) => ipcRenderer.invoke('fs:exists', path),
    listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
    watch: (root) => ipcRenderer.invoke('fs:watch', root),
    onChange: (cb) => on<[FsChangeEvent[]]>('fs:changed', cb)
  },
  search: {
    text: (root, query, options) => ipcRenderer.invoke('search:text', root, query, options)
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    saveFile: (defaultPath) => ipcRenderer.invoke('dialog:saveFile', defaultPath)
  },
  shell: {
    revealInFolder: (path) => ipcRenderer.invoke('shell:reveal', path),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },
  terminal: {
    create: (cwd, cols, rows) => ipcRenderer.invoke('terminal:create', cwd, cols, rows),
    write: (id, data) => ipcRenderer.send('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('terminal:kill', id),
    onData: (cb) => on<[number, string]>('terminal:data', cb),
    onExit: (cb) => on<[number, number]>('terminal:exit', cb)
  },
  ai: {
    providers: () => ipcRenderer.invoke('ai:providers'),
    setKey: (providerId, key) => ipcRenderer.invoke('ai:setKey', providerId, key),
    deleteKey: (providerId) => ipcRenderer.invoke('ai:deleteKey', providerId),
    test: (providerId) => ipcRenderer.invoke('ai:test', providerId),
    models: (providerId, refresh) => ipcRenderer.invoke('ai:models', providerId, refresh),
    usage: () => ipcRenderer.invoke('ai:usage'),
    resetUsage: () => ipcRenderer.invoke('ai:resetUsage'),
    chat: (requestId, request) => ipcRenderer.invoke('ai:chat', requestId, request),
    abort: (requestId) => ipcRenderer.send('ai:abort', requestId),
    onEvent: (cb) => on<[string, ChatEvent]>('ai:event', cb),
    embedTest: (providerId, model) => ipcRenderer.invoke('ai:embedTest', providerId, model),
    complete: (requestId, request) => ipcRenderer.invoke('ai:complete', requestId, request)
  },
  chats: {
    load: (workspace) => ipcRenderer.invoke('chats:load', workspace),
    save: (workspace, data) => ipcRenderer.invoke('chats:save', workspace, data)
  },
  git: {
    diff: (cwd) => ipcRenderer.invoke('git:diff', cwd),
    status: (cwd) => ipcRenderer.invoke('git:status', cwd),
    init: (cwd) => ipcRenderer.invoke('git:init', cwd),
    stage: (cwd, paths) => ipcRenderer.invoke('git:stage', cwd, paths),
    unstage: (cwd, paths) => ipcRenderer.invoke('git:unstage', cwd, paths),
    discard: (cwd, paths) => ipcRenderer.invoke('git:discard', cwd, paths),
    commit: (cwd, message, amend) => ipcRenderer.invoke('git:commit', cwd, message, amend),
    branches: (cwd) => ipcRenderer.invoke('git:branches', cwd),
    checkout: (cwd, branch, create) => ipcRenderer.invoke('git:checkout', cwd, branch, create),
    push: (cwd) => ipcRenderer.invoke('git:push', cwd),
    pull: (cwd) => ipcRenderer.invoke('git:pull', cwd),
    fetch: (cwd) => ipcRenderer.invoke('git:fetch', cwd),
    show: (cwd, ref, path) => ipcRenderer.invoke('git:show', cwd, ref, path),
    stagedDiff: (cwd) => ipcRenderer.invoke('git:stagedDiff', cwd),
    log: (cwd, count) => ipcRenderer.invoke('git:log', cwd, count)
  },
  index: {
    open: (root) => ipcRenderer.invoke('index:open', root),
    status: () => ipcRenderer.invoke('index:status'),
    rebuild: () => ipcRenderer.invoke('index:rebuild'),
    enableEmbeddings: (enabled) => ipcRenderer.invoke('index:enableEmbeddings', enabled),
    clear: () => ipcRenderer.invoke('index:clear'),
    search: (query, limit) => ipcRenderer.invoke('index:search', query, limit),
    settingsChanged: () => ipcRenderer.invoke('index:settingsChanged'),
    onStatus: (cb) => on<[IndexStatus]>('index:status', cb)
  },
  lsp: {
    servers: (root) => ipcRenderer.invoke('lsp:servers', root),
    start: (serverId, root) => ipcRenderer.invoke('lsp:start', serverId, root),
    send: (id, message) => ipcRenderer.send('lsp:send', id, message),
    stop: (id) => ipcRenderer.invoke('lsp:stop', id),
    onMessage: (cb) => on<[number, unknown]>('lsp:message', cb),
    onExit: (cb) => on<[number, number | null]>('lsp:exit', cb)
  },
  mcp: {
    sync: (root) => ipcRenderer.invoke('mcp:sync', root),
    status: () => ipcRenderer.invoke('mcp:status'),
    reconnect: (source, name, root) => ipcRenderer.invoke('mcp:reconnect', source, name, root),
    call: (source, server, tool, args) => ipcRenderer.invoke('mcp:call', source, server, tool, args),
    onStatus: (cb) => on<[McpServerStatus[]]>('mcp:status', cb)
  },
  agent: {
    run: (id, command, cwd, timeoutSeconds) => ipcRenderer.invoke('agent:run', id, command, cwd, timeoutSeconds),
    kill: (id) => ipcRenderer.send('agent:kill', id),
    onOutput: (cb) => on<[string, string]>('agent:output', cb)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (value) => ipcRenderer.invoke('settings:set', value)
  },
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    set: (value) => ipcRenderer.invoke('session:set', value)
  },
  app: {
    onMenuCommand: (cb) => on<[string]>('menu:command', cb),
    onBeforeClose: (cb) => on<[]>('app:before-close', cb),
    confirmClose: () => ipcRenderer.send('app:confirm-close'),
    setTitle: (title) => ipcRenderer.send('app:set-title', title)
  }
}

contextBridge.exposeInMainWorld('api', api)
