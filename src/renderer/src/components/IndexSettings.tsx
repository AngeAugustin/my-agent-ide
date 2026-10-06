import { useState } from 'react'
import { useCodeIndex, indexSummary } from '../store/codeIndex'
import { openSettings, useIde } from '../store/ide'
import { modelLabel, useAi } from '../store/ai'
import { formatTokens } from '../lib/ai'
import { Icon } from './Icon'
import type { SearchHit } from '@shared/codeindex'

export function IndexSettings() {
  const status = useCodeIndex((s) => s.status)
  const workspace = useIde((s) => s.workspace)
  const embeddingRef = useIde((s) => s.settings.ai.models.embeddings)
  useAi((s) => s.providers)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  if (!workspace || !status) {
    return (
      <>
        <h2>Indexation du code</h2>
        <p className="muted">Ouvrez un dossier pour l’indexer.</p>
      </>
    )
  }

  const busy = status.state === 'scanning' || status.state === 'embedding'
  const semantic = status.embeddingsEnabled && !!status.embeddingModel

  return (
    <>
      <h2>Indexation du code</h2>
      <p className="muted">
        L’index permet de retrouver le code pertinent à partir d’une question (<code>@codebase</code> dans le chat, outil de recherche de l’agent,
        recherche sémantique). La recherche par mots-clés est calculée localement ; la recherche sémantique utilise un modèle d’embeddings.
      </p>

      <div className="index-card">
        <div className="index-row">
          <Icon name={busy ? 'loading' : status.state === 'error' ? 'error' : 'database'} className={busy ? 'codicon-modifier-spin' : undefined} />
          <strong>{indexSummary(status)}</strong>
          <span className="muted small">{workspace}</span>
        </div>
        {status.progress && (
          <div className="progress" aria-label="Progression">
            <div className="progress-bar" style={{ width: `${Math.round((status.progress.done / Math.max(status.progress.total, 1)) * 100)}%` }} />
          </div>
        )}
        <dl className="index-stats">
          <div>
            <dt>Fichiers</dt>
            <dd>{status.files}</dd>
          </div>
          <div>
            <dt>Extraits</dt>
            <dd>{status.chunks}</dd>
          </div>
          <div>
            <dt>Recherche</dt>
            <dd>{semantic ? 'mots-clés + sémantique' : 'mots-clés'}</dd>
          </div>
          {semantic && (
            <div>
              <dt>Embeddings</dt>
              <dd>
                {status.embedded}/{status.chunks}
              </dd>
            </div>
          )}
        </dl>
        {status.state === 'error' && <div className="error-text">{status.error}</div>}
        <div className="provider-actions">
          <button className="btn" disabled={busy} onClick={() => window.api.index.rebuild()}>
            <Icon name="refresh" /> Mettre à jour
          </button>
          <button className="btn danger" disabled={busy} onClick={() => window.api.index.clear()}>
            Reconstruire de zéro
          </button>
        </div>
      </div>

      <h3>Recherche sémantique</h3>
      {!embeddingRef ? (
        <div className="callout">
          <Icon name="info" />
          <span>
            Choisissez un modèle d’<em>embeddings</em> dans{' '}
            <button className="link-button inline" onClick={() => openSettings('ai')}>
              Modèles et clés API
            </button>{' '}
            (Voyage AI, OpenAI, Gemini, Mistral, ou un modèle local via Ollama) pour activer la recherche par le sens.
          </span>
        </div>
      ) : status.embeddingsEnabled ? (
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-title">Activée avec {modelLabel(embeddingRef)}</div>
            <div className="setting-description">Les fichiers modifiés sont réindexés automatiquement.</div>
          </div>
          <div className="setting-control">
            <button className="btn" onClick={() => window.api.index.enableEmbeddings(false)}>
              Désactiver
            </button>
          </div>
        </div>
      ) : (
        <div className="callout warning">
          <Icon name="warning" />
          <div>
            <p>
              Le calcul des embeddings envoie le contenu des fichiers indexés à <strong>{embeddingRef.providerId}</strong> (environ{' '}
              <strong>{formatTokens(status.pendingTokens)}</strong> jetons pour ce projet), sauf modèle local. Les fichiers ignorés par Git et les
              dossiers exclus ne sont pas envoyés.
            </p>
            <button className="btn primary" disabled={busy} onClick={() => window.api.index.enableEmbeddings(true)}>
              Activer pour ce projet
            </button>
          </div>
        </div>
      )}

      <h3>Bac à sable de recherche sémantique</h3>
      <form
        className="index-try"
        onSubmit={async (e) => {
          e.preventDefault()
          setError(null)
          try {
            const t0 = performance.now()
            setResults(await window.api.index.search(query, 6))
            setElapsed(Math.round(performance.now() - t0))
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        }}
      >
        <input className="wide" value={query} placeholder="ex. « où est gérée l’authentification ? »" onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!query.trim()}>
          Interroger
        </button>
      </form>
      {error && <div className="error-text">{error}</div>}
      {results && (
        <>
          <div className="sandbox-summary">
            <span>{results.length} extrait(s) pertinent(s)</span>
            <span className="diff-plus">Trouvé(s) en {elapsed} ms</span>
          </div>
          <ul className="index-results">
            {results.length === 0 && <li className="muted">Aucun résultat.</li>}
            {results.map((r, i) => (
              <li key={i} className="sandbox-hit">
                <div className="sandbox-hit-header">
                  <Icon name="link" />
                  <strong>{r.path}</strong>
                  <span className="muted">:{r.startLine}-{r.endLine}</span>
                  <span className="sandbox-score">score : {r.score.toFixed(3)}</span>
                  <span className="muted">Rang n° {i + 1}</span>
                </div>
                <pre className="sandbox-code">{r.text.split('\n').slice(0, 10).join('\n')}</pre>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
