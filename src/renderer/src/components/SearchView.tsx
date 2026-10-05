import { useEffect, useRef, useState } from 'react'
import type { SearchOptions, SearchResult } from '@shared/types'
import { ask, notify, openFile, reportError, useIde } from '../store/ide'
import { getActiveEditor } from '../lib/activeEditor'
import * as models from '../lib/editorModels'
import { fileIcon } from '../lib/fileIcons'
import { basename, dirname, join, relative } from '../lib/paths'
import type { SearchHit } from '@shared/codeindex'
import { useCodeIndex } from '../store/codeIndex'
import { Icon } from './Icon'

function Toggle({ active, onClick, icon, title }: { active: boolean; onClick: () => void; icon: string; title: string }) {
  return (
    <button className={`toggle${active ? ' active' : ''}`} title={title} aria-pressed={active} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}

function buildRegExp(query: string, options: SearchOptions): RegExp {
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (options.wholeWord) source = `\\b(?:${source})\\b`
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
}

export function SearchView() {
  const workspace = useIde((s) => s.workspace)
  const focusNonce = useIde((s) => s.searchFocusNonce)
  const [query, setQuery] = useState('')
  const [semantic, setSemantic] = useState(false)
  const [replace, setReplace] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' })
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const requestId = useRef(0)

  useEffect(() => {
    // Préremplit avec la sélection de l'éditeur, comme dans VS Code.
    const editor = getActiveEditor()
    const sel = editor?.getSelection()
    const text = sel && !sel.isEmpty() ? editor!.getModel()?.getValueInRange(sel) : ''
    if (text && !text.includes('\n')) setQuery(text)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  useEffect(() => {
    if (!workspace || !query || semantic) {
      setResult(null)
      setError(null)
      return
    }
    try {
      buildRegExp(query, options)
    } catch {
      setError('Expression régulière invalide.')
      setResult(null)
      return
    }
    const id = ++requestId.current
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await window.api.search.text(workspace, query, options)
        if (id === requestId.current) {
          setResult(res)
          setError(null)
        }
      } catch (err) {
        if (id === requestId.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [workspace, query, options, semantic])

  const rerun = () => setOptions((o) => ({ ...o }))

  const replaceAll = async () => {
    if (!result || !workspace) return
    const fileCount = result.files.length
    const choice = await ask(
      `Remplacer ${result.totalMatches} occurrence(s) dans ${fileCount} fichier(s) par « ${replace} » ?`,
      undefined,
      [
        { label: 'Remplacer', value: 'ok', primary: true },
        { label: 'Annuler', value: 'cancel' }
      ]
    )
    if (choice !== 'ok') return
    const regex = buildRegExp(query, options)
    let changed = 0
    for (const file of result.files) {
      try {
        const entry = models.getEntry(file.path)
        if (entry) {
          // Fichier ouvert : on modifie le modèle pour garder l'annulation possible.
          const text = entry.model.getValue()
          const next = text.replace(regex, replace)
          if (next !== text) {
            entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: next }], () => null)
            await window.api.fs.writeFile(file.path, next)
            models.markSaved(file.path)
          }
        } else {
          const text = await window.api.fs.readFile(file.path)
          await window.api.fs.writeFile(file.path, text.replace(regex, replace))
        }
        changed++
      } catch (err) {
        reportError(`Remplacement impossible dans « ${basename(file.path)} »`, err)
      }
    }
    notify(`${changed} fichier(s) modifié(s).`, 'success')
    rerun()
  }

  if (!workspace) {
    return (
      <div className="sidebar-section">
        <div className="sidebar-header">
          <span>Recherche</span>
        </div>
        <p className="explorer-empty muted">Ouvrez un dossier pour rechercher dans ses fichiers.</p>
      </div>
    )
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-header">
        <span>Recherche</span>
        <div className="sidebar-actions">
          <button className="icon-button" title="Actualiser" onClick={rerun}>
            <Icon name="refresh" />
          </button>
          <button className="icon-button" title="Tout réduire" onClick={() => setCollapsed(Object.fromEntries((result?.files ?? []).map((f) => [f.path, true])))}>
            <Icon name="collapse-all" />
          </button>
        </div>
      </div>
      <div className="search-form">
        <div className="search-row">
          <button className="icon-button small" title="Afficher/masquer le remplacement" onClick={() => setShowReplace((v) => !v)}>
            <Icon name={showReplace ? 'chevron-down' : 'chevron-right'} />
          </button>
          <div className="search-inputs">
            <div className="input-with-toggles">
              <input
                ref={inputRef}
                value={query}
                placeholder="Rechercher"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && rerun()}
              />
              <Toggle icon="case-sensitive" title="Respecter la casse" active={options.caseSensitive} onClick={() => setOptions((o) => ({ ...o, caseSensitive: !o.caseSensitive }))} />
              <Toggle icon="whole-word" title="Mot entier" active={options.wholeWord} onClick={() => setOptions((o) => ({ ...o, wholeWord: !o.wholeWord }))} />
              {!semantic && (
                <>
                  <Toggle icon="regex" title="Expression régulière" active={options.regex} onClick={() => setOptions((o) => ({ ...o, regex: !o.regex }))} />
                </>
              )}
              <Toggle icon="sparkle" title="Recherche sémantique (par le sens, via l’index du projet)" active={semantic} onClick={() => setSemantic((v) => !v)} />
            </div>
            {showReplace && (
              <div className="input-with-toggles">
                <input value={replace} placeholder="Remplacer" spellCheck={false} onChange={(e) => setReplace(e.target.value)} />
                <button className="toggle" title="Tout remplacer" disabled={!result || result.totalMatches === 0} onClick={replaceAll}>
                  <Icon name="replace-all" />
                </button>
              </div>
            )}
          </div>
        </div>
        <button className="link-button small details-toggle" onClick={() => setShowDetails((v) => !v)}>
          <Icon name="ellipsis" /> {showDetails ? 'Masquer les filtres' : 'Filtres de fichiers'}
        </button>
        {showDetails && (
          <div className="search-details">
            <label>
              Fichiers à inclure
              <input value={options.include} placeholder="ex. : *.ts, src/**" onChange={(e) => setOptions((o) => ({ ...o, include: e.target.value }))} />
            </label>
            <label>
              Fichiers à exclure
              <input value={options.exclude} placeholder="ex. : *.test.ts" onChange={(e) => setOptions((o) => ({ ...o, exclude: e.target.value }))} />
            </label>
          </div>
        )}
      </div>

      {semantic ? (
        <SemanticResults query={query} root={workspace} />
      ) : (
      <>
      <div className="search-summary muted small">
        {error ? (
          <span className="error-text">{error}</span>
        ) : loading ? (
          'Recherche en cours…'
        ) : result ? (
          result.totalMatches === 0 ? (
            'Aucun résultat.'
          ) : (
            `${result.totalMatches} résultat(s) dans ${result.files.length} fichier(s)${result.truncated ? ' (liste tronquée)' : ''}`
          )
        ) : null}
      </div>

      <div className="search-results">
        {result?.files.map((file) => {
          const icon = fileIcon(file.path)
          const isCollapsed = collapsed[file.path]
          const rel = relative(workspace, dirname(file.path))
          return (
            <div key={file.path}>
              <div className="tree-row search-file" onClick={() => setCollapsed((c) => ({ ...c, [file.path]: !c[file.path] }))} title={file.path}>
                <span className="twistie">
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
                </span>
                <Icon name={icon.icon} color={icon.color} />
                <span className="tree-label">{basename(file.path)}</span>
                <span className="muted small path-hint">{rel}</span>
                <span className="badge">{file.matches.length}</span>
              </div>
              {!isCollapsed &&
                file.matches.map((m, i) => (
                  <div
                    key={i}
                    className="tree-row search-match"
                    title={`Ligne ${m.line}`}
                    onClick={() => openFile(file.path, { preview: true, line: m.line, column: m.column, length: m.length })}
                    onDoubleClick={() => openFile(file.path, { preview: false, line: m.line, column: m.column, length: m.length })}
                  >
                    <MatchPreview preview={m.preview} query={query} options={options} />
                  </div>
                ))}
            </div>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
}

/** Résultats de la recherche par l'index (mots-clés + sens si les embeddings sont activés). */
function SemanticResults({ query, root }: { query: string; root: string }) {
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const status = useCodeIndex((s) => s.status)

  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await window.api.index.search(query, 20)
        if (!cancelled) {
          setHits(res)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const mode = status?.embeddingsEnabled && status.embeddingModel ? 'mots-clés + sens' : 'mots-clés (activez les embeddings pour chercher par le sens)'
  return (
    <>
      <div className="search-summary muted small">
        {error ? <span className="error-text">{error}</span> : loading ? 'Recherche…' : hits ? `${hits.length} extrait(s) — ${mode}` : `Index : ${mode}`}
      </div>
      <div className="search-results">
        {hits?.map((h, i) => {
          const abs = join(root, h.path)
          const icon = fileIcon(h.path)
          return (
            <div
              key={i}
              className="semantic-hit"
              onClick={() => openFile(abs, { preview: true, line: h.startLine, column: 1 })}
              onDoubleClick={() => openFile(abs, { preview: false, line: h.startLine, column: 1 })}
              title={`${h.path}:${h.startLine}`}
            >
              <div className="semantic-hit-header">
                <Icon name={icon.icon} color={icon.color} />
                <span className="tree-label">{basename(h.path)}</span>
                <span className="muted small path-hint">
                  {dirname(h.path) === h.path ? '' : dirname(h.path)} · {h.startLine}-{h.endLine}
                </span>
              </div>
              <pre className="semantic-hit-preview">{h.text.split('\n').slice(0, 4).join('\n')}</pre>
            </div>
          )
        })}
      </div>
    </>
  )
}

function MatchPreview({ preview, query, options }: { preview: string; query: string; options: SearchOptions }) {
  let regex: RegExp
  try {
    regex = buildRegExp(query, options)
  } catch {
    return <span>{preview}</span>
  }
  const m = regex.exec(preview)
  if (!m) return <span>{preview}</span>
  return (
    <span>
      {preview.slice(0, m.index)}
      <mark>{m[0]}</mark>
      {preview.slice(m.index + m[0].length)}
    </span>
  )
}
