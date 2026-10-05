import { useEffect } from 'react'
import { refreshLsp, useLsp } from '../lib/lsp'
import { updateSettings, useIde } from '../store/ide'
import { Icon } from './Icon'

const RUN_LABEL = { starting: 'démarrage…', running: 'actif', error: 'arrêté (erreur)' } as const

export function LspSettings() {
  const { servers, running } = useLsp()
  const lsp = useIde((s) => s.settings.lsp)

  useEffect(() => {
    void refreshLsp()
  }, [])

  const toggleServer = (id: string, on: boolean) =>
    updateSettings({ lsp: { ...lsp, disabled: on ? lsp.disabled.filter((d) => d !== id) : [...lsp.disabled, id] } })

  return (
    <>
      <h2>Langages</h2>
      <p className="muted">
        Les serveurs de langage (LSP) apportent la vérification des types sur tout le projet, l’autocomplétion intelligente, l’aller à la définition
        (<kbd>F12</kbd> ou <kbd>Ctrl</kbd>+clic), les références, le renommage (<kbd>F2</kbd>) et les corrections rapides. Ils démarrent quand vous
        ouvrez un fichier du langage concerné.
      </p>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-title">Activer les serveurs de langage</div>
        </div>
        <div className="setting-control">
          <label className="switch">
            <input type="checkbox" aria-label="Serveurs de langage" checked={lsp.enabled} onChange={(e) => void updateSettings({ lsp: { ...lsp, enabled: e.target.checked } })} />
            <span className="switch-track" />
          </label>
        </div>
      </div>
      <div className="provider-list">
        {servers.map((s) => {
          const state = running[s.id]
          return (
            <div key={s.id} className="provider-card lsp-server">
              <div className="provider-header">
                <Icon name={s.available ? 'symbol-namespace' : 'circle-slash'} />
                <span className="provider-name">{s.name}</span>
                <span className={`status-badge ${s.available ? 'ok' : ''}`}>{s.available ? (s.command === 'intégré' ? 'intégré' : 'installé') : 'non installé'}</span>
                {state && <span className="muted small">{RUN_LABEL[state]}</span>}
                <span className="muted small provider-desc">.{s.extensions.join(', .')}</span>
                {s.available && (
                  <label className="switch" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Activer ${s.name}`} checked={!lsp.disabled.includes(s.id)} disabled={!lsp.enabled} onChange={(e) => void toggleServer(s.id, e.target.checked)} />
                    <span className="switch-track" />
                  </label>
                )}
              </div>
              {!s.available && s.installHint && (
                <div className="provider-body">
                  <div className="small">
                    Installation : <code className="install-hint">{s.installHint}</code>
                  </div>
                </div>
              )}
              {s.available && s.command && s.command !== 'intégré' && (
                <div className="provider-body">
                  <div className="muted small">
                    Commande : <code>{s.command}</code>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="provider-actions" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => refreshLsp()}>
          <Icon name="refresh" /> Détecter à nouveau
        </button>
      </div>
    </>
  )
}
