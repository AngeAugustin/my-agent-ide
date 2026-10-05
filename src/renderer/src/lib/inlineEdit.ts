import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ModelRef } from '@shared/ai'
import { monaco } from './monaco'
import { streamChat, type ChatHandle } from './ai'
import { extractCode } from './codeBlocks'
import { diffLines, diffStats } from './diff'
import { INLINE_EDIT_SYSTEM, inlineEditPrompt } from './prompts'
import { isInside, relative } from './paths'
import { notify, useIde } from '../store/ide'
import { InlineEditWidget } from '../components/InlineEditWidget'
import { rulesSection } from './rules'

export type InlineStatus = 'input' | 'streaming' | 'review' | 'error'

export interface InlineState {
  status: InlineStatus
  error?: string
  model?: ModelRef
  stats?: { added: number; removed: number }
  hasSelection: boolean
  history: string[]
}

const CONTEXT_LINES = 150
let current: InlineEditSession | null = null

function editModel(): ModelRef | undefined {
  const m = useIde.getState().settings.ai.models
  return m.edit ?? m.chat
}

/**
 * Session d'édition en ligne (Ctrl+K) : la réponse du modèle est écrite directement
 * dans le fichier, puis présentée sous forme de différences à accepter ou rejeter.
 */
export class InlineEditSession {
  private readonly model: monaco.editor.ITextModel
  private readonly path: string
  /** Première ligne de la zone modifiée (base 1). */
  private readonly startLine: number
  private readonly originalLines: string[]
  /** Nombre de lignes occupées actuellement par la zone dans le fichier. */
  private currentCount: number
  private generated = ''
  private handle: ChatHandle | null = null
  private zoneId: string | null = null
  private removedZones: string[] = []
  private readonly decorations: monaco.editor.IEditorDecorationsCollection
  private readonly rangeDecoration: monaco.editor.IEditorDecorationsCollection
  private readonly overlay: HTMLDivElement
  private readonly root: Root
  private readonly widget: monaco.editor.IOverlayWidget
  private readonly disposables: monaco.IDisposable[] = []
  private state: InlineState
  private disposed = false

  constructor(private readonly editor: monaco.editor.ICodeEditor) {
    this.model = editor.getModel()!
    this.path = useIde.getState().activeId ?? this.model.uri.fsPath
    const sel = editor.getSelection()!
    const hasSelection = !sel.isEmpty()

    if (hasSelection) {
      const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber
      this.startLine = sel.startLineNumber
      this.originalLines = this.model.getLinesContent().slice(sel.startLineNumber - 1, endLine)
    } else {
      // Sans sélection : on remplace la ligne courante si elle est vide, sinon on insère après elle.
      const line = sel.positionLineNumber
      if (this.model.getLineContent(line).trim() === '') {
        this.startLine = line
        this.originalLines = [this.model.getLineContent(line)]
      } else {
        this.startLine = line + 1
        this.originalLines = []
      }
    }
    this.currentCount = this.originalLines.length
    this.state = { status: 'input', hasSelection, model: editModel(), history: [] }

    this.decorations = editor.createDecorationsCollection()
    this.rangeDecoration = editor.createDecorationsCollection()
    this.highlightRange()

    this.overlay = document.createElement('div')
    this.overlay.className = 'inline-edit-overlay'
    this.root = createRoot(this.overlay)
    this.widget = {
      getId: () => 'ide.inlineEdit',
      getDomNode: () => this.overlay,
      getPosition: () => null
    }
    editor.addOverlayWidget(this.widget)
    this.addZone()
    this.render()

    this.disposables.push(
      editor.onDidChangeModel(() => this.cancel('Édition en ligne annulée : le fichier affiché a changé.')),
      editor.onDidLayoutChange(() => this.layout()),
      editor.onKeyDown((e) => {
        if (this.state.status !== 'review') return
        if (e.keyCode === monaco.KeyCode.Enter && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          e.stopPropagation()
          this.accept()
        } else if (e.keyCode === monaco.KeyCode.Escape) {
          e.preventDefault()
          e.stopPropagation()
          this.reject()
        }
      })
    )
  }

  // --- Interface ------------------------------------------------------------

  private render(): void {
    if (this.disposed) return
    this.root.render(
      createElement(InlineEditWidget, {
        state: this.state,
        onSubmit: (instruction: string) => void this.submit(instruction),
        onAccept: () => this.accept(),
        onReject: () => this.reject(),
        onStop: () => this.handle?.abort()
      })
    )
  }

  private setState(patch: Partial<InlineState>): void {
    this.state = { ...this.state, ...patch }
    this.render()
  }

  private addZone(): void {
    const domNode = document.createElement('div')
    this.editor.changeViewZones((acc) => {
      this.zoneId = acc.addZone({
        afterLineNumber: this.startLine - 1,
        heightInPx: 96,
        domNode,
        onDomNodeTop: (top) => {
          this.overlay.style.top = `${top}px`
        },
        onComputedHeight: (height) => {
          this.overlay.style.height = `${height}px`
        }
      })
    })
    this.layout()
  }

  private layout(): void {
    const info = this.editor.getLayoutInfo()
    this.overlay.style.left = `${info.contentLeft}px`
    this.overlay.style.width = `${Math.max(280, Math.min(720, info.contentWidth - info.verticalScrollbarWidth - 24))}px`
  }

  private highlightRange(): void {
    if (this.currentCount === 0) {
      this.rangeDecoration.clear()
      return
    }
    this.rangeDecoration.set([
      {
        range: new monaco.Range(this.startLine, 1, this.startLine + this.currentCount - 1, 1),
        options: { isWholeLine: true, className: 'inline-edit-range' }
      }
    ])
  }

  // --- Modification du texte ---------------------------------------------------

  /** Remplace la zone gérée par `text` (toutes ses lignes). */
  private replaceRegion(text: string): void {
    const lineCount = this.model.getLineCount()
    let range: monaco.Range
    let insert = text
    if (this.currentCount === 0) {
      if (text === '') return
      if (this.startLine <= lineCount) {
        range = new monaco.Range(this.startLine, 1, this.startLine, 1)
        insert = `${text}\n`
      } else {
        const col = this.model.getLineMaxColumn(lineCount)
        range = new monaco.Range(lineCount, col, lineCount, col)
        insert = `\n${text}`
      }
    } else {
      const end = this.startLine + this.currentCount - 1
      range = new monaco.Range(this.startLine, 1, end, this.model.getLineMaxColumn(end))
    }
    this.model.pushEditOperations([], [{ range, text: insert }], () => null)
    this.currentCount = text.split('\n').length
  }

  /** Retire complètement les lignes de la zone (cas d'une insertion rejetée). */
  private removeRegion(): void {
    if (this.currentCount === 0) return
    const end = this.startLine + this.currentCount - 1
    const lineCount = this.model.getLineCount()
    const range =
      end < lineCount
        ? new monaco.Range(this.startLine, 1, end + 1, 1)
        : this.startLine > 1
          ? new monaco.Range(this.startLine - 1, this.model.getLineMaxColumn(this.startLine - 1), end, this.model.getLineMaxColumn(end))
          : new monaco.Range(1, 1, end, this.model.getLineMaxColumn(end))
    this.model.pushEditOperations([], [{ range, text: '' }], () => null)
    this.currentCount = 0
  }

  private restoreOriginal(): void {
    if (this.originalLines.length === 0) this.removeRegion()
    else this.replaceRegion(this.originalLines.join('\n'))
  }

  private clearReview(): void {
    this.decorations.clear()
    if (this.removedZones.length) {
      const ids = this.removedZones
      this.editor.changeViewZones((acc) => ids.forEach((id) => acc.removeZone(id)))
      this.removedZones = []
    }
  }

  private showReview(): void {
    this.clearReview()
    const newLines = this.currentCount === 0 ? [] : this.model.getLinesContent().slice(this.startLine - 1, this.startLine - 1 + this.currentCount)
    const ops = diffLines(this.originalLines, newLines)
    const decos: monaco.editor.IModelDeltaDecoration[] = []
    const zones: Array<{ after: number; lines: string[] }> = []
    for (const op of ops) {
      if (op.type === 'insert') {
        decos.push({
          range: new monaco.Range(this.startLine + op.newStart, 1, this.startLine + op.newStart + op.count - 1, 1),
          options: { isWholeLine: true, className: 'inline-edit-added', linesDecorationsClassName: 'inline-edit-added-gutter' }
        })
      } else if (op.type === 'delete') {
        zones.push({ after: this.startLine + op.newIndex - 1, lines: this.originalLines.slice(op.oldStart, op.oldStart + op.count) })
      }
    }
    this.decorations.set(decos)
    const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo)
    this.editor.changeViewZones((acc) => {
      for (const z of zones) {
        const dom = document.createElement('div')
        dom.className = 'inline-edit-removed'
        dom.style.fontFamily = fontInfo.fontFamily
        dom.style.fontSize = `${fontInfo.fontSize}px`
        dom.style.lineHeight = `${fontInfo.lineHeight}px`
        for (const line of z.lines) {
          const row = document.createElement('div')
          row.textContent = line || ' '
          dom.appendChild(row)
        }
        this.removedZones.push(acc.addZone({ afterLineNumber: z.after, heightInLines: z.lines.length, domNode: dom }))
      }
    })
    this.setState({ status: 'review', stats: diffStats(ops) })
  }

  // --- Requête -----------------------------------------------------------------

  async submit(instruction: string): Promise<void> {
    const model = editModel()
    if (!model) {
      this.setState({ status: 'error', error: 'Aucun modèle d’édition n’est configuré (Paramètres › Modèles et clés API).' })
      return
    }
    if (this.state.status === 'streaming') return
    const previous = this.state.status === 'review' && this.generated ? this.generated : undefined
    this.clearReview()

    const all = this.model.getLinesContent()
    const s = this.startLine - 1
    const e = s + this.currentCount
    // On envoie le contexte autour de la zone, avec le code d'origine (pas la proposition en cours).
    const before = all.slice(Math.max(0, s - CONTEXT_LINES), s).join('\n')
    const after = all.slice(e, e + CONTEXT_LINES).join('\n')
    const ws = useIde.getState().workspace
    const relPath = ws && isInside(ws, this.path) ? relative(ws, this.path) : this.path

    this.setState({ status: 'streaming', error: undefined, model, history: [...this.state.history, instruction] })
    this.editor.updateOptions({ readOnly: true })
    this.model.pushStackElement()

    const rules = await rulesSection([this.path])
    let text = ''
    let lastApplied = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const { code } = extractCode(text)
      if (code !== lastApplied && (code !== '' || this.currentCount > 0)) {
        lastApplied = code
        this.replaceRegion(code)
        this.highlightRange()
      }
    }

    this.handle = streamChat(
      {
        providerId: model.providerId,
        model: model.modelId,
        system: INLINE_EDIT_SYSTEM + rules.text,
        messages: [
          {
            role: 'user',
            content: inlineEditPrompt({
              path: relPath,
              language: this.model.getLanguageId(),
              before: before ? `${before}\n` : '',
              selection: this.originalLines.join('\n'),
              after: after ? `\n${after}` : '',
              instruction,
              previousAttempt: previous
            })
          }
        ]
      },
      (ev) => {
        if (ev.type !== 'text') return
        text += ev.text
        if (!timer) timer = setTimeout(flush, 60)
      }
    )
    const res = await this.handle.result
    this.handle = null
    if (timer) clearTimeout(timer)
    if (this.disposed) return

    if (!res.ok) {
      this.restoreOriginal()
      this.highlightRange()
      this.editor.updateOptions({ readOnly: false })
      this.setState({ status: res.code === 'aborted' ? 'input' : 'error', error: res.code === 'aborted' ? undefined : res.message })
      return
    }
    const finalCode = extractCode(res.text).code
    this.generated = finalCode
    if (finalCode === '' && this.originalLines.length === 0) {
      this.setState({ status: 'error', error: 'Le modèle n’a renvoyé aucun code.' })
      this.editor.updateOptions({ readOnly: false })
      return
    }
    this.replaceRegion(finalCode)
    this.rangeDecoration.clear()
    this.showReview()
  }

  accept(): void {
    if (this.state.status === 'streaming') return
    this.model.pushStackElement()
    this.dispose()
    this.editor.focus()
  }

  reject(): void {
    this.handle?.abort()
    if (this.state.status === 'review' || this.state.status === 'streaming') {
      this.clearReview()
      this.restoreOriginal()
      this.model.pushStackElement()
    }
    this.dispose()
    this.editor.focus()
  }

  private cancel(message: string): void {
    if (this.state.status === 'review' || this.state.status === 'streaming') {
      this.handle?.abort()
      // Le modèle n'est plus affiché, mais on le remet dans son état d'origine.
      this.clearReview()
      this.restoreOriginal()
      notify(message, 'info')
    }
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.handle?.abort()
    this.clearReview()
    this.rangeDecoration.clear()
    this.disposables.forEach((d) => d.dispose())
    if (this.zoneId) {
      const id = this.zoneId
      this.editor.changeViewZones((acc) => acc.removeZone(id))
    }
    this.editor.removeOverlayWidget(this.widget)
    this.editor.updateOptions({ readOnly: false })
    setTimeout(() => this.root.unmount(), 0)
    if (current === this) current = null
  }
}

/** Ouvre (ou referme) l'édition en ligne dans l'éditeur donné. */
export function startInlineEdit(editor: monaco.editor.ICodeEditor | null): void {
  if (!editor?.getModel()) return
  if (current) {
    // Ctrl+K pendant une session : on la ferme si elle attend encore une instruction.
    current.reject()
    return
  }
  current = new InlineEditSession(editor)
}

export function hasInlineSession(): boolean {
  return current !== null
}
