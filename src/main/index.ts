import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { promises as fsp, rmSync } from 'node:fs'
import {
  DEFAULT_SESSION,
  DEFAULT_SETTINGS,
  type SessionState,
  type Settings
} from '@shared/types'
import { abortAllChats, getKeyStore, registerAiHandlers } from './ai/ipc'
import { registerWebHandlers, stopDocs } from './web/ipc'
import { registerDebugHandlers, stopAllDebug } from './debug/ipc'
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
/** Demande de suppression de toutes les données de l'application à la fermeture. */
let wipeDataOnQuit = false

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
    backgroundColor: '#0a0e16',
    // Barre de titre intégrée à l'interface : boutons natifs conservés (feux macOS, superposition ailleurs).
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 20 } }
      : { titleBarOverlay: { color: '#0a0e16', symbolColor: '#bcc9cd', height: 56 } }),
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
  ipcMain.handle('app:dataInfo', async () => {
    const dir = app.getPath('userData')
    return { path: dir, size: await folderSize(dir) }
  })
  ipcMain.on('app:wipe-data-and-quit', () => {
    wipeDataOnQuit = true
    closeConfirmed = true
    app.quit()
  })
  ipcMain.on('app:set-title', (_e, title: string) => mainWindow?.setTitle(title))
  ipcMain.on('app:chrome-theme', (_e, theme: 'dark' | 'light') => {
    if (process.platform === 'darwin' || !mainWindow) return
    try {
      mainWindow.setTitleBarOverlay(theme === 'dark' ? { color: '#0a0e16', symbolColor: '#bcc9cd' } : { color: '#eef1f5', symbolColor: '#3f4c56' })
    } catch {
      // superposition indisponible sur ce système
    }
  })
  ipcMain.on('app:popup-menu', (_e, x: number, y: number) => {
    if (mainWindow) Menu.getApplicationMenu()?.popup({ window: mainWindow, x: Math.round(x), y: Math.round(y) })
  })
  ipcMain.handle('app:metrics', () => {
    const metrics = app.getAppMetrics()
    const memory = metrics.reduce((n, m) => n + (m.memory?.workingSetSize ?? 0), 0) * 1024
    const cpu = metrics.reduce((n, m) => n + (m.cpu?.percentCPUUsage ?? 0), 0)
    return { memory, cpu }
  })
  ipcMain.on('app:toggle-fullscreen', () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()))
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
  registerDebugHandlers(getContents)
  Menu.setApplicationMenu(buildMenu(getContents))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

async function folderSize(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    try {
      if (e.isDirectory()) total += await folderSize(p)
      else if (e.isFile()) total += (await fsp.stat(p)).size
    } catch {
      // fichier inaccessible
    }
  }
  return total
}

/**
 * Efface le dossier de données (paramètres, clés, conversations, index, caches).
 * Chromium réécrit quelques fichiers pendant sa propre fermeture : un petit processus détaché
 * attend la fin de l'application pour terminer la suppression.
 */
function wipeUserData(): void {
  const dir = app.getPath('userData')
  if (process.platform === 'win32') {
    // Plusieurs essais : les fichiers restent verrouillés jusqu'à la fin du processus.
    spawn('cmd.exe', ['/d', '/c', `for /l %i in (1,1,15) do (ping -n 2 127.0.0.1 >nul & rmdir /s /q "${dir}" 2>nul & if not exist "${dir}" exit /b 0)`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
    return
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // le reste sera supprimé après la fermeture
  }
  spawn('/bin/sh', ['-c', 'i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; rm -rf "$2"', 'sh', String(process.pid), dir], {
    detached: true,
    stdio: 'ignore'
  }).unref()
}

app.on('will-quit', () => {
  if (wipeDataOnQuit) wipeUserData()
})

app.on('window-all-closed', () => {
  abortAllChats()
  stopDocs()
  stopAllDebug()
  killAllAgentCommands()
  void closeAllMcp()
  stopAllLsp()
  killAllTerminals()
  stopWatching()
  if (process.platform !== 'darwin') app.quit()
})
