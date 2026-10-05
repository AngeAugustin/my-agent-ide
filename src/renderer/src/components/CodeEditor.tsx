import { useEffect, useRef } from 'react'
import { monaco, languageLabel } from '../lib/monaco'
import * as models from '../lib/editorModels'
import { setActiveEditor } from '../lib/activeEditor'
import { attachNextEdit } from '../lib/nextEdit'
import { pinTab, saveTab, setCursor, useIde } from '../store/ide'

/** Éditeur Monaco unique : on y échange les modèles quand l'onglet actif change. */
export function CodeEditor({ path }: { path: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const currentPath = useRef<string | null>(null)
  const settings = useIde((s) => s.settings)
  const reveal = useIde((s) => s.reveal)

  // Création de l'éditeur.
  useEffect(() => {
    const s = useIde.getState().settings
    const editor = monaco.editor.create(containerRef.current!, {
      model: null,
      automaticLayout: true,
      theme: s.theme === 'dark' ? 'ide-dark' : 'ide-light',
      fontLigatures: true,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      stickyScroll: { enabled: true },
      renderLineHighlight: 'all',
      scrollBeyondLastLine: false,
      padding: { top: 6 },
      fixedOverflowWidgets: true,
      linkedEditing: true,
      formatOnPaste: false,
      inlineSuggest: { enabled: true },
      unicodeHighlight: { ambiguousCharacters: false }
    })
    editorRef.current = editor
    setActiveEditor(editor)
    const detachNextEdit = attachNextEdit(editor)

    const updateCursor = () => {
      const model = editor.getModel()
      const pos = editor.getPosition()
      if (!model || !pos) return setCursor(null)
      const selected = editor
        .getSelections()
        ?.reduce((n, sel) => n + model.getValueLengthInRange(sel), 0) ?? 0
      const opts = model.getOptions()
      setCursor({
        line: pos.lineNumber,
        column: pos.column,
        selected,
        language: languageLabel(model.getLanguageId()),
        eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
        tabSize: opts.tabSize,
        insertSpaces: opts.insertSpaces
      })
    }

    const disposables = [
      editor.onDidChangeCursorSelection(updateCursor),
      editor.onDidChangeModel(updateCursor),
      editor.onDidChangeModelLanguage(updateCursor),
      editor.onDidBlurEditorText(() => {
        if (useIde.getState().settings.autoSave === 'onFocusChange' && currentPath.current && models.isDirty(currentPath.current)) {
          void saveTab(currentPath.current)
        }
      }),
      // Double-clic dans le texte : l'onglet d'aperçu devient permanent.
      editor.onMouseDown((e) => {
        if (e.event.detail >= 2 && currentPath.current) pinTab(currentPath.current)
      })
    ]

    return () => {
      detachNextEdit()
      disposables.forEach((d) => d.dispose())
      if (currentPath.current) models.saveViewState(currentPath.current, editor.saveViewState())
      setActiveEditor(null)
      editor.dispose()
    }
  }, [])

  // Changement de fichier.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (currentPath.current && currentPath.current !== path) {
      models.saveViewState(currentPath.current, editor.saveViewState())
    }
    currentPath.current = path
    const entry = path ? models.getEntry(path) : undefined
    if (!entry) {
      editor.setModel(null)
      setCursor(null)
      return
    }
    if (editor.getModel() !== entry.model) {
      editor.setModel(entry.model)
      if (entry.viewState) editor.restoreViewState(entry.viewState)
    }
    entry.model.updateOptions({ tabSize: useIde.getState().settings.tabSize, insertSpaces: useIde.getState().settings.insertSpaces })
    editor.focus()
  }, [path])

  // Paramètres.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    monaco.editor.setTheme(settings.theme === 'dark' ? 'ide-dark' : 'ide-light')
    editor.updateOptions({
      fontSize: settings.editorFontSize,
      fontFamily: settings.editorFontFamily,
      wordWrap: settings.wordWrap ? 'on' : 'off',
      minimap: { enabled: settings.minimap },
      lineNumbers: settings.lineNumbers ? 'on' : 'off',
      renderWhitespace: settings.renderWhitespace ? 'all' : 'selection'
    })
    editor.getModel()?.updateOptions({ tabSize: settings.tabSize, insertSpaces: settings.insertSpaces })
  }, [settings])

  // Enregistrement automatique après un délai.
  useEffect(() => {
    if (settings.autoSave !== 'afterDelay') return
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const editor = editorRef.current
    const sub = editor?.onDidChangeModelContent(() => {
      const p = currentPath.current
      if (!p || p.startsWith('untitled:') || !models.isDirty(p)) return
      clearTimeout(timers.get(p))
      timers.set(p, setTimeout(() => void saveTab(p), settings.autoSaveDelay))
    })
    return () => {
      sub?.dispose()
      timers.forEach((t) => clearTimeout(t))
    }
  }, [settings.autoSave, settings.autoSaveDelay])

  // Navigation vers une position (résultat de recherche, aller à la ligne…).
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal || reveal.path !== path) return
    const model = editor.getModel()
    if (!model) return
    const line = Math.min(Math.max(reveal.line, 1), model.getLineCount())
    const column = reveal.column
    const range = new monaco.Range(line, column, line, column + (reveal.length ?? 0))
    editor.setSelection(range)
    editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
    editor.focus()
  }, [reveal, path])

  return <div ref={containerRef} className="code-editor" />
}
