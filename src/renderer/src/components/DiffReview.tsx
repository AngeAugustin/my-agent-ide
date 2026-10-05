import { useEffect, useRef, useState } from 'react'
import { monaco, languageForPath } from '../lib/monaco'
import { diffLines, diffStats } from '../lib/diff'
import { acceptReview, closeReview, useReview } from '../store/review'
import { openFile, useIde } from '../store/ide'
import { revertFile } from '../store/agent'
import { relative } from '../lib/paths'
import { Icon } from './Icon'

/** Vue côte à côte d'une modification proposée, à accepter ou rejeter. */
export function DiffReview({ id }: { id: string }) {
  const review = useReview((s) => s.reviews[id])
  const workspace = useIde((s) => s.workspace)
  const theme = useIde((s) => s.settings.theme)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [stats, setStats] = useState({ added: 0, removed: 0 })

  useEffect(() => {
    if (!review) return
    const lang = languageForPath(review.path)
    const original = monaco.editor.createModel(review.original, lang)
    const modified = monaco.editor.createModel(review.proposed, lang)
    modifiedRef.current = modified
    const editor = monaco.editor.createDiffEditor(containerRef.current!, {
      automaticLayout: true,
      originalEditable: false,
      readOnly: !!review.applied || !!review.readonly,
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      fontSize: useIde.getState().settings.editorFontSize,
      fontFamily: useIde.getState().settings.editorFontFamily,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    editor.setModel({ original, modified })
    editorRef.current = editor
    // Un nouveau fichier n'a aucune ligne d'origine (et non une ligne vide).
    const originalLines = () => (review.isNew && original.getValue() === '' ? [] : original.getLinesContent())
    const update = () => setStats(diffStats(diffLines(originalLines(), modified.getLinesContent())))
    update()
    const sub = modified.onDidChangeContent(update)
    return () => {
      sub.dispose()
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
    // Le diff est créé une fois par onglet ; le contenu proposé est mis à jour ci-dessous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Pendant la fusion, l'aperçu suit le texte reçu ; à la fin, le résultat final le remplace une fois.
  // Ensuite, l'utilisateur peut retoucher librement le côté droit avant d'accepter.
  const lastStatus = useRef(review?.status)
  useEffect(() => {
    const m = modifiedRef.current
    if (!m || !review) return
    const finished = lastStatus.current === 'merging' && review.status === 'ready'
    if ((review.status === 'merging' || finished) && m.getValue() !== review.proposed) m.setValue(review.proposed)
    lastStatus.current = review.status
  }, [review?.proposed, review?.status])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide })
  }, [sideBySide])

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'ide-dark' : 'ide-light')
  }, [theme])

  if (!review) return <div className="diff-review empty muted">Cette proposition n’est plus disponible.</div>

  const rel = workspace ? relative(workspace, review.path) : review.path
  return (
    <div className="diff-review">
      <div className="diff-toolbar">
        <Icon name="diff" />
        <span className="diff-path" title={review.path}>
          {rel}
          {review.isNew && !review.readonly && <span className="status-badge ok">nouveau fichier</span>}
          {review.applied && <span className="status-badge">modifié par l’agent</span>}
          {review.readonly && <span className="status-badge">Git</span>}
        </span>
        <span className="diff-stats">
          <span className="added">+{stats.added}</span> <span className="removed">−{stats.removed}</span>
        </span>
        {review.status === 'merging' && (
          <span className="muted small">
            <Icon name="loading" className="codicon-modifier-spin" /> Fusion de la modification…
          </span>
        )}
        {review.status === 'error' && <span className="error-text small">{review.error}</span>}
        <div className="diff-actions">
          <button className="icon-button" title={sideBySide ? 'Vue unifiée' : 'Vue côte à côte'} onClick={() => setSideBySide((v) => !v)}>
            <Icon name={sideBySide ? 'split-vertical' : 'split-horizontal'} />
          </button>
          {review.readonly ? (
            <>
              <button className="btn" onClick={() => openFile(review.path)}>
                <Icon name="go-to-file" /> Ouvrir le fichier
              </button>
              <button className="btn primary" onClick={() => closeReview(id)}>
                Fermer
              </button>
            </>
          ) : review.applied ? (
            <>
              <button
                className="btn danger"
                title="Remettre le fichier dans son état d’avant la modification de l’agent"
                onClick={async () => {
                  await revertFile(review.applied!.convId, review.path, review.applied!.original)
                  await closeReview(id)
                }}
              >
                <Icon name="discard" /> Annuler la modification
              </button>
              <button className="btn primary" onClick={() => closeReview(id)}>
                <Icon name="check" /> Garder
              </button>
            </>
          ) : (
            <>
              <button className="btn danger" onClick={() => closeReview(id)}>
                Rejeter
              </button>
              <button
                className="btn primary"
                disabled={review.status === 'merging'}
                onClick={() => acceptReview(id, modifiedRef.current?.getValue() ?? review.proposed)}
              >
                <Icon name="check" /> Accepter
              </button>
            </>
          )}
        </div>
      </div>
      <div className="diff-container" ref={containerRef} />
    </div>
  )
}
