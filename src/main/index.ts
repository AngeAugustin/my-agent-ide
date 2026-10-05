import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import {
  DEFAULT_SESSION,
  DEFAULT_SETTINGS,
  type SessionState,
  type Settings
} from '@shared/types'
import { abortAllChats, getKeyStore, registerAiHandlers } from './ai/ipc'
import { registerWebHandlers, stopDocs } from './web/ipc'
import { killAllAgentCommands, registerAgentHandlers } from './agentCommands'
import { registerChatHandlers } from './chats'
import { registerGitHandlers } from './git'
import { closeAllMcp, registerMcpHandlers } from './mcp'
import { registerLspHandlers, stopAllLsp } from './lsp'
import { registerIndexHandlers } from './codeindex/ipc'
import { registerFileHandlers, stopWatching } from './files'
import { buildMenu } from './menu'
import { JsonStore } from './store'
import { killAllTerminals, registerTerminalHandlers } from './terminal'

let mainWindow: BrowserWindow | null = null
let closeConfirmed = false

const settingsStore = new JsonStore<Settings>('settings', DEFAULT_SETTINGS)
const sessionStore = new JsonStore<SessionState>('session', DEFAULT_SESSION)
const getContents = () => mainWindow?.webContents ?? null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'My Agent IDE',
    backgroundColor: '#1e1e1e',
    // Icône de fenêtre (Linux) ; les installateurs utilisent build/icon.png.
    ...(process.platform === 'linux' && !app.isPackaged ? { icon: join(__dirname, '../../build/icon.png') } : {}),
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Laisse l'interface vérifier les fichiers non enregistrés avant de fermer.
  mainWindow.on('close', (event) => {
    // Si l'interface a planté, personne ne pourrait confirmer : on ferme directement.
    if (closeConfirmed || mainWindow?.webContents.isCrashed()) return
    event.preventDefault()
    mainWindow?.webContents.send('app:before-close')
  })
  mainWindow.webContents.on('render-process-gone', () => {
    closeConfirmed = true
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    closeConfirmed = false
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerAppHandlers(): void {
  ipcMain.handle('settings:get', () => settingsStore.get())
  ipcMain.handle('settings:set', (_e, value: Settings) => settingsStore.set(value))
  ipcMain.handle('session:get', () => sessionStore.get())
  ipcMain.handle('session:set', (_e, value: SessionState) => sessionStore.set(value))

  ipcMain.handle('dialog:openFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Ouvrir un dossier',
      buttonLabel: 'Ouvrir',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('dialog:openFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Ouvrir un fichier',
      buttonLabel: 'Ouvrir',
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('dialog:saveFile', async (_e, defaultPath?: string) => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: 'Enregistrer sous',
      buttonLabel: 'Enregistrer',
      defaultPath
    })
    return res.canceled ? null : res.filePath
  })

  ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })

  ipcMain.on('app:confirm-close', () => {
    closeConfirmed = true
    mainWindow?.close()
  })
  ipcMain.on('app:set-title', (_e, title: string) => mainWindow?.setTitle(title))
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.myagentide.app')
  registerAppHandlers()
  registerFileHandlers(getContents, async () => (await settingsStore.get()).excludedFolders)
  registerTerminalHandlers(getContents, async () => (await settingsStore.get()).terminalShell)
  const ai = registerAiHandlers(getContents, () => settingsStore.get())
  registerIndexHandlers(getContents, () => settingsStore.get(), ai)
  registerChatHandlers()
  registerWebHandlers(getContents, () => settingsStore.get(), getKeyStore())
  registerGitHandlers()
  registerMcpHandlers(getContents, () => settingsStore.get())
  registerLspHandlers(getContents, () => settingsStore.get())
  registerAgentHandlers(getContents)
  Menu.setApplicationMenu(buildMenu(getContents))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  abortAllChats()
  stopDocs()
  killAllAgentCommands()
  void closeAllMcp()
  stopAllLsp()
  killAllTerminals()
  stopWatching()
  if (process.platform !== 'darwin') app.quit()
})
