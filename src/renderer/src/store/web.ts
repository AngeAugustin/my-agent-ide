import { create } from 'zustand'
import type { DocStatus, SearchProviderId } from '@shared/web'
import { reportError } from './ide'

/** Documentations indexées et clés des moteurs de recherche (masquées). */
export const useWeb = create<{ docs: DocStatus[]; keys: Partial<Record<SearchProviderId, string | null>> }>()(() => ({
  docs: [],
  keys: {}
}))

let initialized = false

export function initWeb(): void {
  if (initialized) return
  initialized = true
  window.api.docs.onStatus((docs) => useWeb.setState({ docs }))
  void refreshWeb()
}

export async function refreshWeb(): Promise<void> {
  try {
    const [docs, keys] = await Promise.all([window.api.docs.list(), window.api.web.keys()])
    useWeb.setState({ docs, keys })
  } catch (err) {
    reportError('Chargement des documentations impossible', err)
  }
}

export async function addDoc(name: string, url: string, maxPages: number): Promise<boolean> {
  try {
    useWeb.setState({ docs: await window.api.docs.add(name, url, maxPages) })
    return true
  } catch (err) {
    reportError('Ajout impossible', err)
    return false
  }
}

export async function removeDoc(id: string): Promise<void> {
  useWeb.setState({ docs: await window.api.docs.remove(id) })
}

export async function setSearchKey(id: SearchProviderId, key: string | null): Promise<void> {
  try {
    if (key) await window.api.web.setKey(id, key)
    else await window.api.web.deleteKey(id)
    useWeb.setState({ keys: await window.api.web.keys() })
  } catch (err) {
    reportError('Enregistrement de la clé impossible', err)
  }
}
