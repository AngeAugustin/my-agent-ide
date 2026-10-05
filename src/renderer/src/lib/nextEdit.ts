import { create } from 'zustand'
import { computeHunks, NEXT_EDIT_SYSTEM, nextEditPrompt, parseNextEdit, pickHunk, recordEdit, type EditRecord, type Hunk } from '@shared/nextEdit'
import { monaco } from './monaco'
import { streamChat, type ChatHandle } from './ai'
import { hasInlineSession } from './inlineEdit'
import { isInside, relative } from './paths'
import { useIde } from '../store/ide'

/** État affiché dans la barre d'état. */
export const useNextEdit = create<{ pending: boolean; visible: boolean; lastError: string | null }>()(() => ({
  pending: false,
  visible: false,
  lastError: null
}))

const REGION_BEFORE = 25
const REGION_AFTER = 35
const DEBOUNCE = 650
/** Au-delà de cette distance (en lignes), le premier Tab déplace le curseur au lieu d'appliquer. */
const JUMP_DISTANCE = 2

interface Suggestion {
  modelUri: string
  versionId: number
  /** Première ligne remplacée (base 1). */
  line: number
  deleteCount: number
  original: string[]
  insert: string[]
}

let edits: EditRecord[] = []

function relPath(path: string): string {
  const ws = useIde.getState().workspace
  return ws && isInside(ws, path) ? relative(ws, path).split('\\').join('/') : path
}

/** Contrôleur attaché à l'éditeur principal. */
class NextEditController {
  private readonly decorations: monaco.editor.IEditorDecorationsCollection
  private zoneId: string | null = null
  private hint: monaco.editor.IContentWidget | null = null
  private suggestion: Suggestion | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private request: ChatHandle | null = null
  private applying = false
  private readonly visibleKey: monaco.editor.IContextKey<boolean>
  private readonly shadow = new Map<string, string>()

  constructor(private readonly editor: monaco.editor.IStandaloneCodeEditor) {
    this.decorations = editor.createDecorationsCollection()
    this.visibleKey = editor.createContextKey('myide.nextEditVisible', false)
    editor.onDidChangeModel(() => {
      this.clear()
      this.snapshot()
    })
    editor.onDidChangeModelContent((e) => this.onContent(e))
    editor.onDidChangeCursorPosition(() => this.updateHint())
    editor.onDidBlurEditorWidget(() => this.cancelRequest())
    editor.addCommand(monaco.KeyCode.Tab, () => this.accept(), 'myide.nextEditVisible && !inlineSuggestionVisible && !suggestWidgetVisible && !inSnippetMode')
    editor.addCommand(monaco.KeyCode.Escape, () => this.clear(), 'myide.nextEditVisible && !suggestWidgetVisible')
    this.snapshot()
  }

  private snapshot(): void {
    const model = this.editor.getModel()
    if (model) this.shadow.set(model.uri.toString(), model.getValue())
  }

  private onContent(e: monaco.editor.IModelContentChangedEvent): void {
    const model = this.editor.getModel()
    if (!model) return
    const key = model.uri.toString()
    const before = this.shadow.get(key)
    this.shadow.set(key, model.getValue())
    this.clear()
    if (this.applying || e.isFlush || model.uri.scheme !== 'file' || before === undefined) return

    // Mémorise la modification (lignes avant / après) pour le prompt.
    if (!e.isUndoing && !e.isRedoing) {
      for (const change of e.changes) {
        const oldStart = before.lastIndexOf('\n', change.rangeOffset - 1) + 1
        let oldEnd = before.indexOf('\n', change.rangeOffset + change.rangeLength)
        if (oldEnd < 0) oldEnd = before.length
        const beforeLines = before.slice(oldStart, oldEnd).split('\n')
        const startLine = change.range.startLineNumber
        const newLineCount = change.text.split('\n').length
        const afterLines = model.getLinesContent().slice(startLine - 1, startLine - 1 + newLineCount)
        edits = recordEdit(edits, { path: relPath(model.uri.fsPath), line: startLine, before: beforeLines, after: afterLines, at: Date.now() })
      }
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.cancelRequest()
    const s = useIde.getState().settings
    if (!s.nextEdit || !s.ai.models.autocomplete || edits.length === 0) return
    this.timer = setTimeout(() => void this.predict(), DEBOUNCE)
  }

  private cancelRequest(): void {
    this.request?.abort()
    this.request = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async predict(): Promise<void> {
    this.timer = null
    const model = this.editor.getModel()
    const pos = this.editor.getPosition()
    const ref = useIde.getState().settings.ai.models.autocomplete
    if (!model || !pos || !ref || hasInlineSession() || model.uri.scheme !== 'file') return
    const versionId = model.getVersionId()
    const total = model.getLineCount()
    const first = Math.max(1, pos.lineNumber - REGION_BEFORE)
    const last = Math.min(total, pos.lineNumber + REGION_AFTER)
    const regionLines = model.getLinesContent().slice(first - 1, last)
    const path = relPath(model.uri.fsPath)

    const handle = streamChat({
      providerId: ref.providerId,
      model: ref.modelId,
      system: NEXT_EDIT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: nextEditPrompt({
            path,
            language: model.getLanguageId(),
            edits: edits.filter((e) => e.path === path).slice(-4),
            regionLines,
            cursor: { line: pos.lineNumber - first, column: pos.column - 1 }
          })
        }
      ],
      maxTokens: 2500,
      effort: 'low'
    })
    this.request = handle
    useNextEdit.setState({ pending: true })
    const result = await handle.result
    if (this.request === handle) this.request = null
    useNextEdit.setState({ pending: false })
    if (!result.ok) {
      if (result.code !== 'aborted') useNextEdit.setState({ lastError: result.message })
      return
    }
    useNextEdit.setState({ lastError: null })
    // Le texte a changé pendant la requête : la prédiction n'est plus valable.
    if (this.editor.getModel() !== model || model.getVersionId() !== versionId) return
    const proposed = parseNextEdit(result.text)
    if (!proposed) return
    const hunk = pickHunk(regionLines, computeHunks(regionLines, proposed), pos.lineNumber - first)
    if (!hunk) return
    this.show(model, versionId, first, regionLines, hunk)
  }

  private show(model: monaco.editor.ITextModel, versionId: number, first: number, region: string[], hunk: Hunk): void {
    this.clear()
    const line = first + hunk.start
    this.suggestion = {
      modelUri: model.uri.toString(),
      versionId,
      line,
      deleteCount: hunk.deleteCount,
      original: region.slice(hunk.start, hunk.start + hunk.deleteCount),
      insert: hunk.insert
    }
    if (hunk.deleteCount > 0) {
      this.decorations.set([
        {
          range: new monaco.Range(line, 1, line + hunk.deleteCount - 1, model.getLineMaxColumn(line + hunk.deleteCount - 1)),
          options: { isWholeLine: true, className: 'next-edit-removed', inlineClassName: 'next-edit-removed-text', linesDecorationsClassName: 'next-edit-gutter' }
        }
      ])
    }
    if (hunk.insert.length) {
      const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo)
      const dom = document.createElement('div')
      dom.className = 'next-edit-added'
      dom.style.fontFamily = fontInfo.fontFamily
      dom.style.fontSize = `${fontInfo.fontSize}px`
      dom.style.lineHeight = `${fontInfo.lineHeight}px`
      for (const l of hunk.insert) {
        const row = document.createElement('div')
        row.textContent = l || ' '
        dom.appendChild(row)
      }
      this.editor.changeViewZones((acc) => {
        this.zoneId = acc.addZone({ afterLineNumber: line + hunk.deleteCount - 1, heightInLines: hunk.insert.length, domNode: dom })
      })
    }
    this.visibleKey.set(true)
    useNextEdit.setState({ visible: true })
    this.updateHint()
  }

  private isNear(): boolean {
    const s = this.suggestion
    const pos = this.editor.getPosition()
    if (!s || !pos) return false
    const end = s.line + Math.max(s.deleteCount, 1) - 1
    return pos.lineNumber >= s.line - JUMP_DISTANCE && pos.lineNumber <= end + JUMP_DISTANCE
  }

  /** Indication « Tab » à côté du curseur : aller à la modification, ou l'accepter. */
  private updateHint(): void {
    if (this.hint) {
      this.editor.removeContentWidget(this.hint)
      this.hint = null
    }
    const s = this.suggestion
    const pos = this.editor.getPosition()
    if (!s || !pos) return
    const near = this.isNear()
    const node = document.createElement('div')
    node.className = 'next-edit-hint'
    node.textContent = near ? 'Tab ⇥ accepter · Échap' : `Tab ⇥ aller à la modification (ligne ${s.line})`
    const model = this.editor.getModel()!
    this.hint = {
      getId: () => 'myide.nextEditHint',
      getDomNode: () => node,
      getPosition: () => ({
        position: { lineNumber: pos.lineNumber, column: model.getLineMaxColumn(pos.lineNumber) },
        preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
      })
    }
    this.editor.addContentWidget(this.hint)
  }

  /** Tab : va à la modification si elle est loin, sinon l'applique (puis cherche la suivante). */
  accept(): void {
    const s = this.suggestion
    const model = this.editor.getModel()
    if (!s || !model || model.uri.toString() !== s.modelUri || model.getVersionId() !== s.versionId) return this.clear()
    if (!this.isNear()) {
      const target = { lineNumber: s.line, column: model.getLineFirstNonWhitespaceColumn(Math.min(s.line, model.getLineCount())) || 1 }
      this.editor.setPosition(target)
      this.editor.revealLineInCenterIfOutsideViewport(s.line)
      this.updateHint()
      return
    }
    const eol = model.getEOL()
    let range: monaco.Range
    let text: string
    if (s.deleteCount > 0) {
      const endLine = s.line + s.deleteCount - 1
      range = new monaco.Range(s.line, 1, endLine, model.getLineMaxColumn(endLine))
      text = s.insert.join(eol)
      if (s.insert.length === 0) {
        // Suppression de lignes entières (avec leur fin de ligne).
        range = endLine < model.getLineCount() ? new monaco.Range(s.line, 1, endLine + 1, 1) : new monaco.Range(Math.max(1, s.line - 1), model.getLineMaxColumn(Math.max(1, s.line - 1)), endLine, model.getLineMaxColumn(endLine))
        text = ''
      }
    } else {
      // Insertion avant la ligne `line`.
      if (s.line > model.getLineCount()) {
        const last = model.getLineCount()
        range = new monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last))
        text = eol + s.insert.join(eol)
      } else {
        range = new monaco.Range(s.line, 1, s.line, 1)
        text = s.insert.join(eol) + eol
      }
    }
    const insertCount = s.insert.length
    this.clear()
    this.applying = true
    try {
      this.editor.pushUndoStop()
      this.editor.executeEdits('next-edit', [{ range, text, forceMoveMarkers: true }])
      this.editor.pushUndoStop()
    } finally {
      this.applying = false
    }
    const endLine = Math.min(model.getLineCount(), s.line + Math.max(insertCount, 1) - 1)
    this.editor.setPosition({ lineNumber: endLine, column: model.getLineMaxColumn(endLine) })
    edits = recordEdit(edits, { path: relPath(model.uri.fsPath), line: s.line, before: s.original, after: s.insert, at: Date.now() - 5000 })
    // Enchaîne : la modification acceptée peut en appeler une autre.
    this.schedule()
  }

  clear(): void {
    this.suggestion = null
    this.decorations.clear()
    if (this.zoneId) {
      const id = this.zoneId
      this.editor.changeViewZones((acc) => acc.removeZone(id))
      this.zoneId = null
    }
    if (this.hint) {
      this.editor.removeContentWidget(this.hint)
      this.hint = null
    }
    this.visibleKey.set(false)
    if (useNextEdit.getState().visible) useNextEdit.setState({ visible: false })
  }
}

let controller: NextEditController | null = null

export function attachNextEdit(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  controller = new NextEditController(editor)
  return () => {
    controller?.clear()
    controller = null
  }
}

/** Pour les tests et les commandes. */
export function acceptNextEdit(): void {
  controller?.accept()
}
