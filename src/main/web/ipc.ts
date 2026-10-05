import { app, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { DEFAULT_WEB_SETTINGS, SEARCH_PROVIDERS, searchKeyId, type SearchProviderId } from '@shared/web'
import type { KeyStore } from '../ai/keyStore'
import { DocsManager } from './docs'
import { fetchPage, webSearch } from './fetcher'

let docs: DocsManager | null = null

export function registerWebHandlers(getContents: () => WebContents | null, getSettings: () => Promise<Settings>, keys: KeyStore): void {
  docs = new DocsManager(join(app.getPath('userData'), 'docs'), (statuses) => getContents()?.send('docs:status', statuses))

  const provider = async (): Promise<SearchProviderId> => ({ ...DEFAULT_WEB_SETTINGS, ...(await getSettings()).web }).searchProvider

  ipcMain.handle('web:search', async (_e, query: string, count?: number) => {
    const id = await provider()
    return webSearch(id, await keys.get(searchKeyId(id)), query, Math.max(1, Math.min(count ?? 6, 10)))
  })
  ipcMain.handle('web:fetch', (_e, url: string, maxChars?: number) => fetchPage(url, maxChars))
  ipcMain.handle('web:keys', async () => {
    const list = await keys.list()
    return Object.fromEntries(SEARCH_PROVIDERS.map((p) => [p.id, list[searchKeyId(p.id)]?.masked ?? null]))
  })
  ipcMain.handle('web:setKey', (_e, id: SearchProviderId, key: string) => {
    if (!SEARCH_PROVIDERS.some((p) => p.id === id)) throw new Error('Moteur inconnu.')
    return keys.set(searchKeyId(id), key)
  })
  ipcMain.handle('web:deleteKey', (_e, id: SearchProviderId) => keys.delete(searchKeyId(id)))

  ipcMain.handle('docs:list', () => docs!.list())
  ipcMain.handle('docs:add', (_e, name: string, url: string, maxPages: number) => docs!.add(name, url, maxPages))
  ipcMain.handle('docs:remove', (_e, id: string) => docs!.remove(id))
  ipcMain.handle('docs:reindex', (_e, id: string) => {
    void docs!.reindex(id)
  })
  ipcMain.handle('docs:search', (_e, ids: string[], query: string, limit?: number) => docs!.search(ids, query, limit))
}

export function stopDocs(): void {
  docs?.cancelAll()
}
