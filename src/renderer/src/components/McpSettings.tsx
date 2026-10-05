import { useEffect, useState } from 'react'
import { parseMcpConfig, type McpServerStatus } from '@shared/mcp'
import { setAutoApprove, setProjectServerEnabled, syncMcp, useMcp } from '../store/mcp'
import { updateSettings, useIde } from '../store/ide'
import { Icon } from './Icon'

const EXAMPLE = `{
  "mcpServers": {
    "fichiers": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "distant": {
      "url": "https://exemple.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}`

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  disabled: 'désactivé',
  connecting: 'connexion…',
  connected: 'connecté',
  error: 'erreur'
}

function ServerRow({ server }: { server: McpServerStatus }) {
  const [open, setOpen] = useState(false)
  const settings = useIde((s) => s.settings)
  const workspace = useIde((s) => s.workspace)
  const enabled = server.state !== 'disabled'

  const toggle = async () => {
    if (server.source === 'project') return setProjectServerEnabled(server.name, !enabled)
    const entry = settings.mcpServers[server.name]
    if (entry) await updateSettings({ mcpServers: { ...settings.mcpServers, [server.name]: { ...entry, disabled: enabled } } })
  }

  return (
    <div className={`provider-card mcp-server ${server.state}`}>
      <div className="provider-header" onClick={() => setOpen((v) => !v)} role="button">
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="provider-name">{server.name}</span>
        <span className={`status-badge ${server.state === 'connected' ? 'ok' : ''}`}>{STATE_LABEL[server.state]}</span>
        {server.source === 'project' && <span className="status-badge">projet</span>}
        {server.state === 'connected' && <span className="muted small">{server.tools.length} outil(s)</span>}
        <span className="muted small provider-desc mono" title={server.target}>
          {server.target}
        </span>
      </div>
      {open && (
        <div className="provider-body">
          {server.source === 'project' && !enabled && (
            <div className="callout warning">
              <Icon name="warning" />
              <span>
                Ce serveur est déclaré par le projet (<code>.cursor/mcp.json</code>). Il lancera la commande ci-dessus sur votre machine : ne l’activez
                que si vous faites confiance à ce dépôt.
              </span>
            </div>
          )}
          {server.error && <div className="provider-result error">{server.error}</div>}
          <div className="provider-actions">
            <button className={`btn${enabled ? '' : ' primary'}`} onClick={toggle}>
              {enabled ? 'Désactiver' : server.source === 'project' ? 'Autoriser et activer pour ce projet' : 'Activer'}
            </button>
            {enabled && (
              <button className="btn" onClick={() => window.api.mcp.reconnect(server.source, server.name, workspace)}>
                <Icon name="refresh" /> Reconnecter
              </button>
            )}
            <label className="checkbox small" title="Les outils de ce serveur s’exécutent sans demander votre accord">
              <input type="checkbox" checked={server.autoApprove} onChange={(e) => setAutoApprove(server.source, server.name, e.target.checked)} /> Exécuter sans
              confirmation
            </label>
          </div>
          {server.tools.length > 0 && (
            <ul className="mcp-tools">
              {server.tools.map((t) => (
                <li key={t.name}>
                  <code>{t.name}</code> <span className="muted small">{t.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export function McpSettings() {
  const servers = useMcp((s) => s.servers)
  const mcpServers = useIde((s) => s.settings.mcpServers)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setText(Object.keys(mcpServers).length ? JSON.stringify({ mcpServers }, null, 2) : '')
  }, [mcpServers])

  useEffect(() => {
    void syncMcp()
  }, [])

  const save = async () => {
    try {
      const parsed = parseMcpConfig(text)
      setError(null)
      await updateSettings({ mcpServers: parsed })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <h2>Serveurs MCP</h2>
      <p className="muted">
        Les serveurs MCP (Model Context Protocol) donnent de nouveaux outils à l’agent : bases de données, navigateur, GitHub, Jira, documentation…
        Chaque appel demande votre accord, sauf si vous l’autorisez pour un serveur.
      </p>

      {servers.length > 0 ? (
        <div className="provider-list">
          {servers.map((s) => (
            <ServerRow key={`${s.source}:${s.name}`} server={s} />
          ))}
        </div>
      ) : (
        <p className="muted">Aucun serveur configuré.</p>
      )}

      <h3>Configuration (format Cursor / Claude Desktop)</h3>
      <textarea
        className="allowlist mcp-json"
        rows={14}
        spellCheck={false}
        placeholder={EXAMPLE}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="error-text">{error}</div>}
      <div className="provider-actions">
        <button className="btn primary" onClick={save}>
          {saved ? 'Enregistré' : 'Enregistrer'}
        </button>
        {!text && (
          <button className="btn" onClick={() => setText(EXAMPLE)}>
            Insérer un exemple
          </button>
        )}
        <span className="muted small">
          Les serveurs du projet sont lus dans <code>.cursor/mcp.json</code> ou <code>.mcp.json</code> et doivent être autorisés un par un.
        </span>
      </div>
    </>
  )
}
