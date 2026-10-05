import { useState } from 'react'
import { SEARCH_PROVIDERS, type DocStatus, type SearchProviderId, type WebSearchResult } from '@shared/web'
import { updateSettings, useIde } from '../store/ide'
import { addDoc, removeDoc, setSearchKey, useWeb } from '../store/web'
import { Icon } from './Icon'

function docSummary(d: DocStatus): string {
  if (d.state === 'indexing') return `Indexation… ${d.progress?.done ?? 0} page(s) lue(s)`
  if (d.state === 'error') return d.error ?? 'Erreur'
  if (!d.indexedAt) return 'En attente'
  return `${d.pages} page(s), ${d.chunks} extrait(s) · ${new Date(d.indexedAt).toLocaleDateString('fr-FR')}`
}

export function WebSettings() {
  const web = useIde((s) => s.settings.web)
  const { docs, keys } = useWeb()
  const [keyDraft, setKeyDraft] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [maxPages, setMaxPages] = useState(50)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WebSearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const provider = SEARCH_PROVIDERS.find((p) => p.id === web.searchProvider) ?? SEARCH_PROVIDERS[0]
  const setWeb = (partial: Partial<typeof web>) => updateSettings({ web: { ...web, ...partial } })

  return (
    <>
      <h2>Web et documentation</h2>
      <p className="muted">
        <code>@web</code> lance une recherche sur Internet avec votre question, <code>@https://…</code> joint une page, et <code>@</code> suivi du nom
        d’une documentation y cherche les passages utiles. L’agent peut aussi chercher sur le web et lire des pages.
      </p>

      <h3>Recherche sur Internet</h3>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Moteur de recherche</div>
          <div className="setting-description">{provider.description}</div>
        </div>
        <div className="setting-control">
          <select value={web.searchProvider} onChange={(e) => setWeb({ searchProvider: e.target.value as SearchProviderId })}>
            {SEARCH_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.requiresKey ? (keys[p.id] ? ' (clé enregistrée)' : ' (clé requise)') : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      {provider.requiresKey && (
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-title">Clé API {provider.name}</div>
            <div className="setting-description">
              Chiffrée sur cet ordinateur.{' '}
              {provider.keyUrl && (
                <button className="link-button inline" onClick={() => window.api.shell.openExternal(provider.keyUrl!)}>
                  Obtenir une clé
                </button>
              )}
            </div>
          </div>
          <div className="setting-control">
            {keys[provider.id] ? (
              <>
                <code>{keys[provider.id]}</code>
                <button className="btn" onClick={() => setSearchKey(provider.id, null)}>
                  Supprimer
                </button>
              </>
            ) : (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void setSearchKey(provider.id, keyDraft).then(() => setKeyDraft(''))
                }}
              >
                <input type="password" value={keyDraft} placeholder="Clé API" onChange={(e) => setKeyDraft(e.target.value)} aria-label={`Clé ${provider.name}`} />
                <button className="btn primary" type="submit" disabled={!keyDraft.trim()}>
                  Enregistrer
                </button>
              </form>
            )}
          </div>
        </div>
      )}
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Outils web de l’agent</div>
          <div className="setting-description">Permet à l’agent de chercher sur Internet, de lire des pages et de consulter vos documentations.</div>
        </div>
        <div className="setting-control">
          <label className="switch">
            <input type="checkbox" checked={web.agentTools} onChange={(e) => setWeb({ agentTools: e.target.checked })} aria-label="Outils web de l’agent" />
            <span className="switch-track" />
          </label>
        </div>
      </div>
      <form
        className="index-try"
        onSubmit={async (e) => {
          e.preventDefault()
          setError(null)
          setResults(null)
          setTesting(true)
          try {
            setResults(await window.api.web.search(query, 5))
          } catch (err) {
            setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
          } finally {
            setTesting(false)
          }
        }}
      >
        <input className="wide" value={query} placeholder="Essayer une recherche…" onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" type="submit" disabled={!query.trim() || testing}>
          {testing ? 'Recherche…' : 'Rechercher'}
        </button>
      </form>
      {error && <div className="error-text">{error}</div>}
      {results && (
        <ul className="index-results">
          {results.length === 0 && <li className="muted">Aucun résultat.</li>}
          {results.map((r) => (
            <li key={r.url}>
              <strong>{r.title}</strong> <span className="muted small">{r.url}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Documentations</h3>
      <p className="muted small">
        L’IDE parcourt les pages situées sous l’adresse indiquée (même site, même chemin) et les indexe sur cet ordinateur. Exemple :
        <code> https://react.dev/reference/</code>
      </p>
      <div className="doc-list">
        {docs.length === 0 && <div className="muted">Aucune documentation ajoutée.</div>}
        {docs.map((d) => (
          <div key={d.id} className="index-card doc-card">
            <div className="index-row">
              <Icon name={d.state === 'indexing' ? 'loading' : d.state === 'error' ? 'error' : 'book'} className={d.state === 'indexing' ? 'codicon-modifier-spin' : undefined} />
              <strong>{d.name}</strong>
              <span className="muted small">{d.url}</span>
            </div>
            <div className={d.state === 'error' ? 'error-text' : 'muted small'}>{docSummary(d)}</div>
            <div className="provider-actions">
              <button className="btn" disabled={d.state === 'indexing'} onClick={() => window.api.docs.reindex(d.id)}>
                <Icon name="refresh" /> Réindexer
              </button>
              <button className="btn danger" onClick={() => removeDoc(d.id)}>
                Supprimer
              </button>
            </div>
          </div>
        ))}
      </div>
      <form
        className="doc-add"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await addDoc(name, url, maxPages)) {
            setName('')
            setUrl('')
          }
        }}
      >
        <input value={name} placeholder="Nom (ex. React)" onChange={(e) => setName(e.target.value)} aria-label="Nom de la documentation" />
        <input className="wide" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} aria-label="Adresse de la documentation" />
        <label className="muted small">
          Pages max.{' '}
          <input type="number" min={1} max={500} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value) || 50)} />
        </label>
        <button className="btn primary" type="submit" disabled={!url.trim()}>
          Ajouter
        </button>
      </form>
    </>
  )
}
