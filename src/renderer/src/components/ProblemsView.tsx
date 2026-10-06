import { useEffect, useState } from 'react'
import { monaco } from '../lib/monaco'
import { basename, isInside, relative } from '../lib/paths'
import { openFile, useIde } from '../store/ide'
import { addContext, focusChat } from '../store/chat'
import { Icon } from './Icon'

interface Problem {
  path: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning' | 'info'
  source?: string
}

function readProblems(): Problem[] {
  return monaco.editor
    .getModelMarkers({})
    .filter((m) => m.resource.scheme === 'file')
    .map((m) => ({
      path: m.resource.fsPath,
      line: m.startLineNumber,
      column: m.startColumn,
      message: m.message,
      severity: (m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info') as Problem['severity'],
      source: m.source
    }))
    .sort((a, b) => (a.severity === b.severity ? a.path.localeCompare(b.path) || a.line - b.line : a.severity === 'error' ? -1 : b.severity === 'error' ? 1 : 0))
}

export function useProblemCount(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const update = () => setN(monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file' && m.severity >= monaco.MarkerSeverity.Warning).length)
    update()
    const sub = monaco.editor.onDidChangeMarkers(update)
    return () => sub.dispose()
  }, [])
  return n
}

/** Panneau « Problèmes » : erreurs et avertissements des fichiers ouverts, avec envoi à l'IA. */
export function ProblemsView({ visible }: { visible: boolean }) {
  const ws = useIde((s) => s.workspace)
  const [problems, setProblems] = useState<Problem[]>([])
  useEffect(() => {
    const update = () => setProblems(readProblems())
    update()
    const sub = monaco.editor.onDidChangeMarkers(update)
    return () => sub.dispose()
  }, [])
  const rel = (p: string) => (ws && isInside(ws, p) ? relative(ws, p).split('\\').join('/') : p)
  return (
    <div className="problems-view" style={{ display: visible ? 'flex' : 'none' }}>
      {problems.length === 0 ? (
        <div className="muted problems-empty">
          <Icon name="pass" /> Aucun problème détecté dans les fichiers ouverts.
        </div>
      ) : (
        <>
          <div className="problems-toolbar">
            <span className="muted small">{problems.length} problème(s)</span>
            <button
              className="toolbar-button"
              onClick={() => {
                addContext({ kind: 'problems' })
                focusChat()
              }}
              title="Joint les problèmes à la conversation"
            >
              <Icon name="sparkle" /> Corriger avec l’IA
            </button>
          </div>
          <div className="problems-list">
            {problems.map((p, i) => (
              <button key={i} className={`problem-row ${p.severity}`} onClick={() => void openFile(p.path, { line: p.line, column: p.column })}>
                <Icon name={p.severity === 'error' ? 'error' : p.severity === 'warning' ? 'warning' : 'info'} />
                <span className="problem-message">{p.message}</span>
                <span className="muted small problem-location" title={rel(p.path)}>
                  {basename(p.path)}:{p.line}:{p.column}
                  {p.source ? ` · ${p.source}` : ''}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
