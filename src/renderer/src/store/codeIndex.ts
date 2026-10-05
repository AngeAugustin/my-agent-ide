import { create } from 'zustand'
import type { IndexStatus } from '@shared/codeindex'
import { useIde } from './ide'

export const useCodeIndex = create<{ status: IndexStatus | null }>()(() => ({ status: null }))

let subscribed = false

/** Ouvre l'index du projet courant et suit son état (appelé au démarrage). */
export function initCodeIndex(): void {
  if (subscribed) return
  subscribed = true
  window.api.index.onStatus((status) => {
    if (status.root === useIde.getState().workspace) useCodeIndex.setState({ status })
  })
  const open = (root: string | null) => {
    if (!root) return useCodeIndex.setState({ status: null })
    void window.api.index.open(root).then((status) => useCodeIndex.setState({ status }))
  }
  open(useIde.getState().workspace)
  useIde.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace) open(s.workspace)
  })
}

export function indexSummary(status: IndexStatus | null): string {
  if (!status) return 'Aucun projet'
  switch (status.state) {
    case 'scanning':
      return status.progress ? `Indexation… ${status.progress.done}/${status.progress.total}` : 'Indexation…'
    case 'embedding':
      return status.progress ? `Embeddings… ${status.progress.done}/${status.progress.total}` : 'Embeddings…'
    case 'error':
      return 'Erreur d’indexation'
    default:
      return `${status.files} fichiers indexés`
  }
}
