import { create } from 'zustand'
import type { ModelRef } from '@shared/ai'
import { streamChat, type ChatHandle } from '../lib/ai'
import { extractCode, hasElisionMarkers } from '../lib/codeBlocks'
import * as models from '../lib/editorModels'
import { basename } from '../lib/paths'
import { APPLY_SYSTEM, applyPrompt } from '../lib/prompts'
import { closeTab, notify, onTabClosed, openFile, reportError, useIde, type Tab } from './ide'

/** Modification proposée (par le chat) en attente de validation dans une vue de différences. */
export interface Review {
  id: string
  path: string
  original: string
  proposed: string
  isNew: boolean
  status: 'merging' | 'ready' | 'error'
  error?: string
  /** Modification déjà appliquée par l'agent : la vue permet seulement de la consulter ou de l'annuler. */
  applied?: { convId: string; original: string | null }
}

interface ReviewState {
  reviews: Record<string, Review>
}

export const useReview = create<ReviewState>()(() => ({ reviews: {} }))
const handles = new Map<string, ChatHandle>()

export const reviewTabId = (path: string) => `ide://diff/${path}`

function setReview(id: string, patch: Partial<Review>): void {
  useReview.setState((s) => (s.reviews[id] ? { reviews: { ...s.reviews, [id]: { ...s.reviews[id], ...patch } } } : {}))
}

function editModel(): ModelRef | undefined {
  const m = useIde.getState().settings.ai.models
  return m.edit ?? m.chat
}

/** Ouvre la vue de différences pour appliquer un bloc de code à un fichier. */
export async function applyCodeToFile(path: string, code: string): Promise<void> {
  const entry = models.getEntry(path)
  let original = ''
  let isNew = false
  if (entry) original = entry.model.getValue()
  else if (await window.api.fs.exists(path)) {
    try {
      original = await window.api.fs.readFile(path)
    } catch (err) {
      reportError('Lecture impossible', err)
      return
    }
  } else isNew = true

  const id = reviewTabId(path)
  handles.get(id)?.abort()

  // Un fichier complet est appliqué tel quel ; un extrait est fusionné par le modèle d'édition.
  const origLines = original.split('\n').length
  const codeLines = code.split('\n').length
  const needsMerge = !isNew && original.trim() !== '' && (hasElisionMarkers(code) || codeLines < origLines * 0.6)
  const model = editModel()
  const canMerge = needsMerge && !!model

  useReview.setState((s) => ({
    reviews: { ...s.reviews, [id]: { id, path, original, proposed: canMerge ? original : code, isNew, status: canMerge ? 'merging' : 'ready' } }
  }))

  const tabs = useIde.getState().tabs
  if (!tabs.some((t) => t.id === id)) {
    const tab: Tab = { id, kind: 'diff', title: `${basename(path)} (modification)`, dirty: false, preview: false }
    useIde.setState({ tabs: [...tabs, tab] })
  }
  useIde.setState({ activeId: id })

  if (!canMerge) {
    if (needsMerge) notify('Aucun modèle d’édition configuré : l’extrait est proposé tel quel.', 'info')
    return
  }

  let text = ''
  const h = streamChat(
    {
      providerId: model.providerId,
      model: model.modelId,
      system: APPLY_SYSTEM,
      messages: [{ role: 'user', content: applyPrompt(path, original, code) }]
    },
    (ev) => {
      if (ev.type !== 'text') return
      text += ev.text
      const { code: partial } = extractCode(text)
      if (partial) setReview(id, { proposed: partial })
    }
  )
  handles.set(id, h)
  const res = await h.result
  handles.delete(id)
  if (res.ok) {
    let merged = extractCode(res.text).code
    if (original.endsWith('\n') && !merged.endsWith('\n')) merged += '\n'
    setReview(id, { proposed: merged, status: 'ready' })
  } else if (res.code !== 'aborted') setReview(id, { status: 'error', error: res.message })
}

/** Applique le contenu validé dans l'éditeur (modification annulable, non enregistrée). */
export async function acceptReview(id: string, content: string): Promise<void> {
  const review = useReview.getState().reviews[id]
  if (!review) return
  try {
    if (review.isNew) {
      await window.api.fs.createFile(review.path)
      await window.api.fs.writeFile(review.path, content)
      await openFile(review.path)
    } else {
      await openFile(review.path)
      const entry = models.getEntry(review.path)
      if (!entry) throw new Error('Fichier introuvable dans l’éditeur.')
      entry.model.pushStackElement()
      entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null)
      entry.model.pushStackElement()
    }
  } catch (err) {
    reportError('Application impossible', err)
    return
  }
  await closeReview(id)
  notify(review.isNew ? `Fichier « ${basename(review.path)} » créé.` : `Modification appliquée à « ${basename(review.path)} » (non enregistrée).`, 'success')
}

export async function closeReview(id: string): Promise<void> {
  handles.get(id)?.abort()
  handles.delete(id)
  await closeTab(id, true)
}

onTabClosed((id) => {
  if (id.startsWith('ide://diff/')) disposeReview(id)
})

function disposeReview(id: string): void {
  handles.get(id)?.abort()
  handles.delete(id)
  useReview.setState((s) => {
    const reviews = { ...s.reviews }
    delete reviews[id]
    return { reviews }
  })
}

/** Affiche ce que l'agent a modifié dans un fichier (état d'avant le tour → état actuel). */
export async function openAgentDiff(convId: string, path: string, original: string | null): Promise<void> {
  let current = ''
  try {
    const entry = models.getEntry(path)
    current = entry ? entry.model.getValue() : (await window.api.fs.exists(path)) ? await window.api.fs.readFile(path) : ''
  } catch (err) {
    reportError('Lecture impossible', err)
    return
  }
  const id = reviewTabId(path)
  useReview.setState((s) => ({
    reviews: {
      ...s.reviews,
      [id]: { id, path, original: original ?? '', proposed: current, isNew: original === null, status: 'ready', applied: { convId, original } }
    }
  }))
  const tabs = useIde.getState().tabs
  if (!tabs.some((t) => t.id === id)) {
    useIde.setState({ tabs: [...tabs, { id, kind: 'diff', title: `${basename(path)} (agent)`, dirty: false, preview: false }] })
  }
  useIde.setState({ activeId: id })
}
