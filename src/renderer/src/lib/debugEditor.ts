import type { SourceBreakpoint } from '@shared/debug'
import { monaco } from './monaco'
import { currentLocation, editCondition, setBreakpoints, toggleBreakpoint, useDebug } from '../store/debug'

/** Points d'arrêt dans la marge et ligne en cours d'exécution, pour l'éditeur principal. */
export function attachDebugDecorations(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  const breakpointDecos = editor.createDecorationsCollection()
  const currentDeco = editor.createDecorationsCollection()
  const hoverDeco = editor.createDecorationsCollection()
  /** Décoration → point d'arrêt (pour suivre les lignes déplacées par les modifications). */
  let rendered: Array<{ bp: SourceBreakpoint }> = []

  const pathOf = () => {
    const model = editor.getModel()
    return model && model.uri.scheme === 'file' ? model.uri.fsPath : null
  }

  const render = () => {
    const path = pathOf()
    const bps = path ? (useDebug.getState().breakpoints[path] ?? []) : []
    const model = editor.getModel()
    rendered = bps.map((bp) => ({ bp }))
    breakpointDecos.set(
      bps
        .filter((bp) => model && bp.line <= model.getLineCount())
        .map((bp) => ({
          range: new monaco.Range(bp.line, 1, bp.line, 1),
          options: {
            glyphMarginClassName: `debug-breakpoint${bp.enabled === false ? ' disabled' : ''}${bp.condition ? ' conditional' : ''}`,
            glyphMarginHoverMessage: { value: bp.condition ? `Point d’arrêt conditionnel : \`${bp.condition}\`` : 'Point d’arrêt (clic pour retirer, clic droit pour une condition)' },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        }))
    )
    const loc = currentLocation()
    currentDeco.set(
      path && loc && loc.path === path
        ? [
            {
              range: new monaco.Range(loc.line, 1, loc.line, 1),
              options: {
                isWholeLine: true,
                className: loc.top ? 'debug-current-line' : 'debug-frame-line',
                glyphMarginClassName: loc.top ? 'debug-current-arrow' : 'debug-frame-arrow',
                zIndex: 10
              }
            }
          ]
        : []
    )
  }

  const disposables = [
    editor.onDidChangeModel(render),
    editor.onMouseDown((e) => {
      const path = pathOf()
      if (!path || e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return
      const line = e.target.position.lineNumber
      if (e.event.rightButton) {
        // Clic droit : condition du point d'arrêt, modifiée dans la vue Débogage.
        const current = useDebug.getState().breakpoints[path] ?? []
        if (!current.some((b) => b.line === line)) setBreakpoints(path, [...current, { line }])
        editCondition(path, line)
        return
      }
      toggleBreakpoint(path, line)
    }),
    editor.onMouseMove((e) => {
      // Point fantôme au survol de la marge.
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        const line = e.target.position.lineNumber
        hoverDeco.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'debug-breakpoint-hint' } }])
      } else hoverDeco.clear()
    }),
    editor.onMouseLeave(() => hoverDeco.clear()),
    editor.onDidChangeModelContent(() => {
      // Les points d'arrêt suivent les lignes insérées ou supprimées au-dessus d'eux.
      const path = pathOf()
      const model = editor.getModel()
      if (!path || !model || rendered.length === 0) return
      const ranges = breakpointDecos.getRanges()
      if (ranges.length !== rendered.length) return
      const moved = rendered.map((r, i) => ({ ...r.bp, line: ranges[i].startLineNumber }))
      const unique = moved.filter((b, i) => moved.findIndex((x) => x.line === b.line) === i)
      if (unique.some((b, i) => b.line !== rendered[i]?.bp.line) || unique.length !== rendered.length) setBreakpoints(path, unique)
    })
  ]
  const unsubscribe = useDebug.subscribe((s, prev) => {
    if (s.breakpoints !== prev.breakpoints || s.session !== prev.session || s.frameId !== prev.frameId || s.frames !== prev.frames) render()
  })
  render()

  return () => {
    unsubscribe()
    disposables.forEach((d) => d.dispose())
  }
}
