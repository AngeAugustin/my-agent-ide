import type { monaco } from './monaco'

let active: monaco.editor.IStandaloneCodeEditor | null = null
const listeners = new Set<() => void>()

export function setActiveEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  active = editor
  listeners.forEach((l) => l())
}

export function getActiveEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return active
}

/** Prévient quand l'éditeur principal est créé ou détruit. */
export function onActiveEditorChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
