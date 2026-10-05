import { app, ipcMain, safeStorage, type WebContents } from 'electron'
import { join } from 'node:path'
import type { ChatRequest, KeyStorageInfo } from '@shared/ai'
import type { CompletionRequest } from '@shared/completion'
import type { Settings } from '@shared/types'
import { JsonStore } from '../store'
import { KeyStore, type Encryptor } from './keyStore'
import { AiService, type ModelCache, type UsageStats } from './service'

function storageBackend(): string {
  if (process.platform === 'darwin') return 'Trousseau macOS'
  if (process.platform === 'win32') return 'DPAPI Windows'
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return 'inconnu'
  }
}

const electronEncryptor: Encryptor = {
  // Sous Linux sans trousseau, Electron se rabat sur « basic_text », un chiffrement à mot de passe fixe.
  isSecure: () => safeStorage.isEncryptionAvailable() && storageBackend() !== 'basic_text',
  backend: storageBackend,
  encrypt: (plain) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Chiffrement indisponible')
    return safeStorage.encryptString(plain)
  },
  decrypt: (data) => safeStorage.decryptString(data)
}

const controllers = new Map<string, AbortController>()

export function registerAiHandlers(getContents: () => WebContents | null, getSettings: () => Promise<Settings>): AiService {
  const service = new AiService({
    keys: new KeyStore(join(app.getPath('userData'), 'api-keys.json'), electronEncryptor),
    getSettings: async () => (await getSettings()).ai,
    modelCache: new JsonStore<ModelCache>('models-cache', {}),
    usage: new JsonStore<UsageStats>('usage', {}),
    storageInfo: (): KeyStorageInfo => ({ encrypted: electronEncryptor.isSecure(), backend: electronEncryptor.backend() })
  })

  ipcMain.handle('ai:providers', () => service.statuses())
  ipcMain.handle('ai:setKey', (_e, providerId: string, key: string) => service.setKey(providerId, key))
  ipcMain.handle('ai:deleteKey', (_e, providerId: string) => service.deleteKey(providerId))
  ipcMain.handle('ai:test', (_e, providerId: string) => service.test(providerId))
  ipcMain.handle('ai:models', (_e, providerId: string, refresh?: boolean) => service.models(providerId, refresh))
  ipcMain.handle('ai:usage', () => service.usage())
  ipcMain.handle('ai:resetUsage', () => service.resetUsage())

  ipcMain.handle('ai:chat', (_e, requestId: string, request: ChatRequest) => {
    const controller = new AbortController()
    controllers.set(requestId, controller)
    void service
      .chat(request, (event) => getContents()?.send('ai:event', requestId, event), controller.signal)
      .finally(() => controllers.delete(requestId))
  })
  ipcMain.handle('ai:embedTest', async (_e, providerId: string, model: string) => {
    try {
      const [v] = await service.embed(providerId, model, ['function bonjour() { return "monde" }'], 'query')
      return { ok: true, dims: v.length }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })
  ipcMain.on('ai:abort', (_e, requestId: string) => controllers.get(requestId)?.abort())

  ipcMain.handle('ai:complete', async (_e, requestId: string, request: CompletionRequest) => {
    const controller = new AbortController()
    controllers.set(requestId, controller)
    try {
      return { ok: true, result: await service.complete(request, controller.signal) }
    } catch (err) {
      const e = err as { code?: string; message?: string }
      return { ok: false, code: e.code ?? 'unknown', message: e.message ?? String(err) }
    } finally {
      controllers.delete(requestId)
    }
  })

  return service
}

export function abortAllChats(): void {
  for (const c of controllers.values()) c.abort()
  controllers.clear()
}
