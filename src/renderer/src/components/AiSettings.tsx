import { useEffect, useState } from 'react'
import { MODEL_ROLES, type CustomProvider, type ModelRef, type ModelRole, type ProviderStatus } from '@shared/ai'
import { ask, notify, updateSettings, useIde } from '../store/ide'
import { applyDefaultModels, loadAi, readyProviders, setModelForRole, useAi } from '../store/ai'
import { formatTokens, streamChat, type ChatHandle } from '../lib/ai'
import { Icon } from './Icon'

const CUSTOM_VALUE = '__custom__'

function refKey(ref?: ModelRef): string {
  return ref ? `${ref.providerId}::${ref.modelId}` : ''
}

function ModelPicker({ role }: { role: ModelRole }) {
  const current = useIde((s) => s.settings.ai.models[role])
  useAi((s) => s.providers)
  const ready = readyProviders(role === 'embeddings' ? 'embedding' : 'chat')
  const providers = useAi.getState().providers
  const inLists = !!current && ready.some((p) => p.id === current.providerId && p.models.some((m) => m.id === current.modelId))
  const [custom, setCustom] = useState(!!current && !inLists)
  const [customProvider, setCustomProvider] = useState(current?.providerId ?? ready[0]?.id ?? '')
  const [customModel, setCustomModel] = useState(current && !inLists ? current.modelId : '')

  useEffect(() => {
    if (current && !inLists) setCustom(true)
  }, [current, inLists])

  const configured = providers.filter((p) => p.hasKey || !p.requiresKey)

  return (
    <div className="model-picker">
      <select
        value={custom ? CUSTOM_VALUE : refKey(current)}
        onChange={(e) => {
          const v = e.target.value
          if (v === CUSTOM_VALUE) {
            setCustom(true)
            return
          }
          setCustom(false)
          if (!v) return setModelForRole(role, undefined)
          const [providerId, ...rest] = v.split('::')
          setModelForRole(role, { providerId, modelId: rest.join('::') })
        }}
      >
        <option value="">Aucun</option>
        {ready.map((p) => (
          <optgroup key={p.id} label={p.name}>
            {p.models.map((m) => (
              <option key={m.id} value={`${p.id}::${m.id}`}>
                {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM_VALUE}>Saisir un identifiant de modèle…</option>
      </select>
      {custom && (
        <div className="model-custom">
          <select value={customProvider} onChange={(e) => setCustomProvider(e.target.value)}>
            {configured.length === 0 && <option value="">Aucun fournisseur configuré</option>}
            {configured.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            placeholder="identifiant du modèle"
            value={customModel}
            spellCheck={false}
            onChange={(e) => setCustomModel(e.target.value)}
            onBlur={() => {
              if (customProvider && customModel.trim()) setModelForRole(role, { providerId: customProvider, modelId: customModel.trim() })
            }}
          />
        </div>
      )}
    </div>
  )
}

function ModelTest({ role }: { role: ModelRole }) {
  const ref = useIde((s) => s.settings.ai.models[role])
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<{ kind: 'idle' | 'running' | 'ok' | 'error'; detail?: string }>({ kind: 'idle' })
  const [handle, setHandle] = useState<ChatHandle | null>(null)

  const run = async () => {
    if (!ref) return
    setOutput('')
    setStatus({ kind: 'running' })
    const started = performance.now()
    if (role === 'embeddings') {
      const res = await window.api.ai.embedTest(ref.providerId, ref.modelId)
      const ms = Math.round(performance.now() - started)
      setStatus(res.ok ? { kind: 'ok', detail: `Vecteurs de ${res.dims} dimensions · ${(ms / 1000).toFixed(1).replace('.', ',')} s` } : { kind: 'error', detail: res.message })
      void loadAi()
      return
    }
    const h = streamChat(
      {
        providerId: ref.providerId,
        model: ref.modelId,
        maxTokens: 2000,
        messages: [{ role: 'user', content: 'Réponds uniquement par la phrase : « Connexion réussie. »' }]
      },
      (ev) => {
        if (ev.type === 'text') setOutput((o) => o + ev.text)
        if (ev.type === 'notice') setOutput((o) => `${o}\n[${ev.message}]\n`)
      }
    )
    setHandle(h)
    const res = await h.result
    setHandle(null)
    const ms = Math.round(performance.now() - started)
    if (res.ok) {
      setStatus({
        kind: 'ok',
        detail: `${(ms / 1000).toFixed(1).replace('.', ',')} s · ${res.inputTokens} jetons en entrée, ${res.outputTokens} en sortie`
      })
    } else setStatus({ kind: res.code === 'aborted' ? 'idle' : 'error', detail: res.message })
    void loadAi()
  }

  if (!ref) return null
  return (
    <div className="model-test">
      {handle ? (
        <button className="btn" onClick={() => handle.abort()}>
          <Icon name="debug-stop" /> Arrêter
        </button>
      ) : (
        <button className="btn" onClick={run}>
          <Icon name="play" /> Tester
        </button>
      )}
      {(output || status.kind !== 'idle') && (
        <div className={`model-test-result ${status.kind}`}>
          {output && <div className="model-test-output">{output}</div>}
          {status.kind === 'running' && !output && <div className="muted">Envoi de la requête…</div>}
          {status.detail && <div className={status.kind === 'error' ? 'error-text' : 'muted small'}>{status.detail}</div>}
        </div>
      )}
    </div>
  )
}

function ProviderCard({ provider }: { provider: ProviderStatus }) {
  const ai = useIde((s) => s.settings.ai)
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [baseUrl, setBaseUrl] = useState(ai.providers[provider.id]?.baseUrl ?? '')

  const usable = provider.hasKey || !provider.requiresKey

  const test = async () => {
    setBusy('test')
    setResult(null)
    const res = await window.api.ai.test(provider.id)
    await loadAi()
    setBusy(null)
    if (res.ok) {
      setResult({ ok: true, message: `Connexion réussie : ${res.modelCount} modèle(s) disponible(s).` })
      applyDefaultModels(provider.id)
    } else setResult({ ok: false, message: res.error ?? 'Échec de la connexion.' })
  }

  const saveKey = async () => {
    if (!key.trim()) return
    setBusy('save')
    try {
      await window.api.ai.setKey(provider.id, key)
      setKey('')
      await loadAi()
    } catch (err) {
      setBusy(null)
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
      return
    }
    await test()
  }

  const removeKey = async () => {
    const choice = await ask(`Supprimer la clé API de ${provider.name} ?`, 'Les modèles de ce fournisseur ne seront plus utilisables.', [
      { label: 'Supprimer', value: 'ok', danger: true, primary: true },
      { label: 'Annuler', value: 'cancel' }
    ])
    if (choice !== 'ok') return
    await window.api.ai.deleteKey(provider.id)
    setResult(null)
    await loadAi()
  }

  const removeProvider = async () => {
    const choice = await ask(`Supprimer le fournisseur « ${provider.name} » ?`, undefined, [
      { label: 'Supprimer', value: 'ok', danger: true, primary: true },
      { label: 'Annuler', value: 'cancel' }
    ])
    if (choice !== 'ok') return
    await window.api.ai.deleteKey(provider.id)
    const models = Object.fromEntries(Object.entries(ai.models).filter(([, ref]) => ref?.providerId !== provider.id))
    await updateSettings({ ai: { ...ai, customProviders: ai.customProviders.filter((c) => c.id !== provider.id), models } })
    await loadAi()
  }

  const saveBaseUrl = async () => {
    const value = baseUrl.trim()
    if (value && !/^https?:\/\//.test(value)) {
      setResult({ ok: false, message: 'L’URL doit commencer par http:// ou https://.' })
      return
    }
    const providers = { ...ai.providers, [provider.id]: { ...ai.providers[provider.id], baseUrl: value || undefined } }
    await updateSettings({ ai: { ...ai, providers } })
    await loadAi()
  }

  const badge = provider.local
    ? { label: provider.models.length ? 'Connecté' : 'Local', cls: provider.models.length ? 'ok' : '' }
    : provider.hasKey
      ? { label: 'Configuré', cls: 'ok' }
      : { label: 'Non configuré', cls: '' }

  return (
    <div className={`provider-card${open ? ' open' : ''}`} data-provider={provider.id}>
      <button className="provider-header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="provider-name">{provider.name}</span>
        <span className={`status-badge ${badge.cls}`}>{badge.label}</span>
        {provider.maskedKey && <code className="masked-key">{provider.maskedKey}</code>}
        <span className="muted small provider-desc">{provider.description}</span>
      </button>
      {open && (
        <div className="provider-body">
          {provider.requiresKey && (
            <div className="provider-row">
              <label htmlFor={`key-${provider.id}`}>{provider.hasKey ? 'Remplacer la clé' : 'Clé API'}</label>
              <div className="provider-inline">
                <input
                  id={`key-${provider.id}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={provider.keyPlaceholder ?? 'Collez votre clé API'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                />
                <button className="btn primary" disabled={!key.trim() || !!busy} onClick={saveKey}>
                  {busy === 'save' ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              </div>
              {provider.keyUrl && (
                <button className="link-button small" onClick={() => window.api.shell.openExternal(provider.keyUrl!)}>
                  <Icon name="link-external" /> Obtenir une clé
                </button>
              )}
            </div>
          )}
          {provider.baseUrlEditable && (
            <div className="provider-row">
              <label htmlFor={`url-${provider.id}`}>URL de base</label>
              <input
                id={`url-${provider.id}`}
                className="wide"
                spellCheck={false}
                placeholder={provider.defaultBaseUrl}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={saveBaseUrl}
              />
            </div>
          )}
          {!provider.baseUrlEditable && provider.custom && (
            <div className="provider-row muted small">URL : {provider.baseUrl}</div>
          )}
          <div className="provider-actions">
            <button className="btn" disabled={!usable || !!busy} onClick={test}>
              <Icon name="plug" /> {busy === 'test' ? 'Test en cours…' : provider.local ? 'Tester la connexion' : 'Tester et charger les modèles'}
            </button>
            {provider.hasKey && (
              <button className="btn danger" onClick={removeKey}>
                Supprimer la clé
              </button>
            )}
            {provider.custom && (
              <button className="btn danger" onClick={removeProvider}>
                Supprimer le fournisseur
              </button>
            )}
            {provider.models.length > 0 && <span className="muted small">{provider.models.length} modèle(s) en cache</span>}
          </div>
          {result && <div className={`provider-result ${result.ok ? 'ok' : 'error'}`}>{result.message}</div>}
        </div>
      )}
    </div>
  )
}

function AddProvider() {
  const ai = useIde((s) => s.settings.ai)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [requiresKey, setRequiresKey] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    if (!name.trim()) return setError('Donnez un nom au fournisseur.')
    if (!/^https?:\/\/.+/.test(baseUrl.trim())) return setError('L’URL doit commencer par http:// ou https://.')
    const slug = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    let id = `custom-${slug || 'fournisseur'}`
    let n = 2
    while (ai.customProviders.some((c) => c.id === id)) id = `custom-${slug}-${n++}`
    const provider: CustomProvider = { id, name: name.trim(), baseUrl: baseUrl.trim().replace(/\/+$/, ''), requiresKey }
    await updateSettings({ ai: { ...ai, customProviders: [...ai.customProviders, provider] } })
    setName('')
    setBaseUrl('')
    setError(null)
    setOpen(false)
    notify(`Fournisseur « ${provider.name} » ajouté.`, 'success')
    await loadAi()
  }

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        <Icon name="add" /> Ajouter un fournisseur compatible OpenAI
      </button>
    )
  }
  return (
    <div className="add-provider">
      <p className="muted small">
        Toute API compatible avec le format OpenAI (vLLM, Together, Fireworks, Azure, un proxy d’entreprise…).
      </p>
      <label>
        Nom
        <input value={name} placeholder="Mon serveur" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        URL de base
        <input className="wide" value={baseUrl} spellCheck={false} placeholder="https://exemple.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={requiresKey} onChange={(e) => setRequiresKey(e.target.checked)} /> Nécessite une clé API
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="provider-actions">
        <button className="btn primary" onClick={add}>
          Ajouter
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Annuler
        </button>
      </div>
    </div>
  )
}

function UsageTable() {
  const usage = useAi((s) => s.usage)
  const providers = useAi((s) => s.providers)
  const rows = Object.entries(usage).sort((a, b) => b[1].lastUsed - a[1].lastUsed)
  if (rows.length === 0) return <p className="muted">Aucune requête pour le moment.</p>
  return (
    <>
      <table className="shortcuts-table usage-table">
        <thead>
          <tr>
            <th>Fournisseur</th>
            <th>Requêtes</th>
            <th>Jetons en entrée</th>
            <th>Jetons en sortie</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, u]) => (
            <tr key={id}>
              <td>{providers.find((p) => p.id === id)?.name ?? id}</td>
              <td>{u.requests}</td>
              <td>{formatTokens(u.inputTokens)}</td>
              <td>{formatTokens(u.outputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="link-button small"
        onClick={async () => {
          await window.api.ai.resetUsage()
          await loadAi()
        }}
      >
        Remettre les compteurs à zéro
      </button>
    </>
  )
}

export function AiSettingsSection() {
  const loaded = useAi((s) => s.loaded)
  const providers = useAi((s) => s.providers)
  const storage = useAi((s) => s.storage)
  const showReasoning = useIde((s) => s.settings.showReasoning)
  const autocomplete = useIde((s) => s.settings.autocomplete)
  const autocompleteDelay = useIde((s) => s.settings.autocompleteDelay)

  useEffect(() => {
    void loadAi()
  }, [])

  if (!loaded) return <p className="muted">Chargement…</p>
  const noneReady = readyProviders().length === 0

  return (
    <div className="ai-settings">
      <h2>Modèles et clés API</h2>
      {storage && (
        <div className={`callout ${storage.encrypted ? '' : 'warning'}`}>
          <Icon name={storage.encrypted ? 'lock' : 'warning'} />
          <span>
            {storage.encrypted
              ? `Vos clés sont chiffrées par le système (${storage.backend}) et ne sont envoyées qu’au fournisseur concerné.`
              : `Aucun trousseau sécurisé n’est disponible (${storage.backend}) : les clés sont stockées sans chiffrement fort sur ce poste. Installez un trousseau (GNOME Keyring, KWallet) pour les protéger.`}
          </span>
        </div>
      )}

      <h3>Modèle par usage</h3>
      {noneReady && <p className="muted">Configurez d’abord un fournisseur ci-dessous, puis choisissez vos modèles.</p>}
      {MODEL_ROLES.map((r) => (
        <div className="setting-row model-role" key={r.id}>
          <div className="setting-text">
            <div className="setting-title">{r.label}</div>
            <div className="setting-description">{r.description}</div>
          </div>
          <div className="setting-control model-role-control">
            <ModelPicker role={r.id} />
            <ModelTest role={r.id} />
          </div>
        </div>
      ))}

      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Afficher la réflexion du modèle</div>
          <div className="setting-description">Montre un résumé du raisonnement dans le chat, quand le modèle le fournit.</div>
        </div>
        <div className="setting-control">
          <label className="switch">
            <input type="checkbox" aria-label="Afficher la réflexion" checked={showReasoning} onChange={(e) => void updateSettings({ showReasoning: e.target.checked })} />
            <span className="switch-track" />
          </label>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Autocomplétion pendant la frappe</div>
          <div className="setting-description">
            Suggestions grisées : <kbd>Tab</kbd> pour accepter, <kbd>Ctrl+→</kbd> mot par mot, <kbd>Échap</kbd> pour ignorer, <kbd>Alt+\</kbd> pour en demander une.
          </div>
        </div>
        <div className="setting-control">
          <label className="switch">
            <input type="checkbox" aria-label="Autocomplétion" checked={autocomplete} onChange={(e) => void updateSettings({ autocomplete: e.target.checked })} />
            <span className="switch-track" />
          </label>
        </div>
      </div>
      {autocomplete && (
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-title">Délai avant suggestion</div>
            <div className="setting-description">En millisecondes après la dernière frappe. Plus court : plus réactif, mais plus de requêtes.</div>
          </div>
          <div className="setting-control">
            <input
              type="number"
              min={50}
              max={3000}
              step={50}
              value={autocompleteDelay}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v >= 50 && v <= 3000) void updateSettings({ autocompleteDelay: v })
              }}
            />
          </div>
        </div>
      )}

      <AgentSettingsSection />

      <h3>Fournisseurs</h3>
      <div className="provider-list">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>
      <div className="add-provider-wrap">
        <AddProvider />
      </div>

      <h3>Consommation</h3>
      <p className="muted small">Jetons comptés par l’IDE depuis la dernière remise à zéro. Le coût réel dépend des tarifs de chaque fournisseur.</p>
      <UsageTable />
    </div>
  )
}

function AgentSettingsSection() {
  const agent = useIde((s) => s.settings.agent)
  const [allowText, setAllowText] = useState(agent.allowlist.join('\n'))
  useEffect(() => setAllowText(agent.allowlist.join('\n')), [agent.allowlist])
  const set = (patch: Partial<typeof agent>) => void updateSettings({ agent: { ...agent, ...patch } })
  return (
    <>
      <h3>Agent</h3>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Exécution des commandes</div>
          <div className="setting-description">
            Les modifications de fichiers sont appliquées directement (avec point de restauration) ; les commandes demandent votre accord, sauf celles
            de la liste ci-dessous.
          </div>
        </div>
        <div className="setting-control">
          <select value={agent.commandPolicy} onChange={(e) => set({ commandPolicy: e.target.value as typeof agent.commandPolicy })}>
            <option value="allowlist">Demander, sauf commandes autorisées</option>
            <option value="always">Tout exécuter sans demander (risqué)</option>
          </select>
        </div>
      </div>
      {agent.commandPolicy === 'allowlist' && (
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-title">Commandes autorisées</div>
            <div className="setting-description">
              Une par ligne. Une commande passe sans confirmation si elle commence par l’une d’elles et ne contient ni enchaînement (« ; », « && »,
              « | ») ni redirection. Laissez vide pour toujours demander.
            </div>
          </div>
          <div className="setting-control">
            <textarea
              className="allowlist"
              rows={6}
              spellCheck={false}
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              onBlur={() =>
                set({
                  allowlist: allowText
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)
                })
              }
            />
          </div>
        </div>
      )}
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Nombre maximal d’étapes</div>
          <div className="setting-description">Appels au modèle par demande, avant que l’agent ne s’arrête et vous rende la main.</div>
        </div>
        <div className="setting-control">
          <input type="number" min={1} max={200} value={agent.maxSteps} onChange={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= 200) set({ maxSteps: v }) }} />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Délai maximal d’une commande</div>
          <div className="setting-description">En secondes ; la commande est arrêtée au-delà.</div>
        </div>
        <div className="setting-control">
          <input type="number" min={5} max={3600} value={agent.commandTimeout} onChange={(e) => { const v = Number(e.target.value); if (v >= 5 && v <= 3600) set({ commandTimeout: v }) }} />
        </div>
      </div>
    </>
  )
}
