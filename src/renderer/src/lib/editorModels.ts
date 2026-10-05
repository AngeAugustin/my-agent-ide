import { languageForPath, monaco } from './monaco'

/** Données associées à chaque fichier ouvert, conservées hors de React. */
interface ModelEntry {
  model: monaco.editor.ITextModel
  savedVersionId: number
  viewState: monaco.editor.ICodeEditorViewState | null
}

const entries = new Map<string, ModelEntry>()
const dirtyListeners = new Set<(path: string, dirty: boolean) => void>()

function uriFor(path: string): monaco.Uri {
  return path.startsWith('untitled:') ? monaco.Uri.parse(path) : monaco.Uri.file(path)
}

export function onDirtyChange(cb: (path: string, dirty: boolean) => void): () => void {
  dirtyListeners.add(cb)
  return () => dirtyListeners.delete(cb)
}

export function getEntry(path: string): ModelEntry | undefined {
  return entries.get(path)
}

export function createModel(path: string, content: string, language?: string): monaco.editor.ITextModel {
  const existing = entries.get(path)
  if (existing) return existing.model
  const uri = uriFor(path)
  monaco.editor.getModel(uri)?.dispose()
  const model = monaco.editor.createModel(content, language ?? languageForPath(path), uri)
  const entry: ModelEntry = { model, savedVersionId: model.getAlternativeVersionId(), viewState: null }
  entries.set(path, entry)

  let wasDirty = false
  model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== entry.savedVersionId
    if (dirty !== wasDirty) {
      wasDirty = dirty
      dirtyListeners.forEach((cb) => cb(path, dirty))
    }
  })
  return model
}

export function isDirty(path: string): boolean {
  const e = entries.get(path)
  return !!e && e.model.getAlternativeVersionId() !== e.savedVersionId
}

export function markSaved(path: string): void {
  const e = entries.get(path)
  if (!e) return
  e.savedVersionId = e.model.getAlternativeVersionId()
  dirtyListeners.forEach((cb) => cb(path, false))
}

/** Remplace le contenu (rechargement depuis le disque) en gardant l'historique d'annulation. */
export function reloadContent(path: string, content: string): void {
  const e = entries.get(path)
  if (!e || e.model.getValue() === content) return
  e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text: content }], () => null)
  markSaved(path)
}

export function disposeModel(path: string): void {
  const e = entries.get(path)
  if (!e) return
  e.model.dispose()
  entries.delete(path)
}

/** Déplace un modèle vers un nouveau chemin (renommage ou « Enregistrer sous »). */
export function moveModel(from: string, to: string): void {
  const e = entries.get(from)
  if (!e) return
  const content = e.model.getValue()
  const wasDirty = isDirty(from)
  const viewState = e.viewState
  disposeModel(from)
  createModel(to, content)
  const next = entries.get(to)!
  next.viewState = viewState
  if (wasDirty) next.savedVersionId = -1
}

export function saveViewState(path: string, state: monaco.editor.ICodeEditorViewState | null): void {
  const e = entries.get(path)
  if (e) e.viewState = state
}
