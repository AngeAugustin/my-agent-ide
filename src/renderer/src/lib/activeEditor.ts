import type { monaco } from './monaco'

let active: monaco.editor.IStandaloneCodeEditor | null = null

export function setActiveEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  active = editor
}

export function getActiveEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return active
}
