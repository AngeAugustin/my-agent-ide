import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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
