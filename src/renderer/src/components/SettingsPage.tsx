import { useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { updateSettings, useIde } from '../store/ide'
import { AiSettingsSection } from './AiSettings'
import { IndexSettings } from './IndexSettings'
import { McpSettings } from './McpSettings'
import { LspSettings } from './LspSettings'
import { commands } from '../lib/commands'
import { formatKeybinding } from '../lib/keybindings'

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {description && <div className="setting-description">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function NumberInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (!Number.isNaN(v) && v >= min && v <= max) onChange(v)
      }}
    />
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="switch-track" />
    </label>
  )
}

type Section = 'general' | 'editor' | 'terminal' | 'files' | 'shortcuts' | 'ai' | 'index' | 'mcp' | 'lsp'

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'general', label: 'Général' },
  { id: 'editor', label: 'Éditeur' },
  { id: 'lsp', label: 'Langages' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Fichiers' },
  { id: 'ai', label: 'Modèles et clés API' },
  { id: 'index', label: 'Indexation du code' },
  { id: 'mcp', label: 'Serveurs MCP' },
  { id: 'shortcuts', label: 'Raccourcis clavier' }
]

export function SettingsPage() {
  const s = useIde((st) => st.settings)
  const section = useIde((st) => st.settingsSection) as Section
  const setSection = (id: Section) => useIde.setState({ settingsSection: id })
  const [filter, setFilter] = useState('')
  const set = (partial: Partial<Settings>) => updateSettings(partial)

  return (
    <div className="settings-page">
      <nav className="settings-nav">
        <h1>Paramètres</h1>
        {SECTIONS.map((sec) => (
          <button key={sec.id} className={section === sec.id ? 'active' : ''} onClick={() => setSection(sec.id)}>
            {sec.label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === 'general' && (
          <>
            <h2>Général</h2>
            <Row title="Thème" description="Apparence de l’interface et de l’éditeur.">
              <select value={s.theme} onChange={(e) => set({ theme: e.target.value as Settings['theme'] })}>
                <option value="dark">Sombre</option>
                <option value="light">Clair</option>
              </select>
            </Row>
            <Row title="Enregistrement automatique" description="Enregistre les fichiers modifiés sans action de votre part.">
              <select value={s.autoSave} onChange={(e) => set({ autoSave: e.target.value as Settings['autoSave'] })}>
                <option value="off">Désactivé</option>
                <option value="afterDelay">Après un délai</option>
                <option value="onFocusChange">Quand l’éditeur perd le focus</option>
              </select>
            </Row>
            {s.autoSave === 'afterDelay' && (
              <Row title="Délai d’enregistrement automatique" description="En millisecondes.">
                <NumberInput value={s.autoSaveDelay} min={200} max={60000} onChange={(v) => set({ autoSaveDelay: v })} />
              </Row>
            )}
            <div className="settings-footer">
              <button className="btn" onClick={() => updateSettings(DEFAULT_SETTINGS)}>
                Rétablir les paramètres par défaut
              </button>
            </div>
          </>
        )}

        {section === 'editor' && (
          <>
            <h2>Éditeur</h2>
            <Row title="Taille de police">
              <NumberInput value={s.editorFontSize} min={8} max={40} onChange={(v) => set({ editorFontSize: v })} />
            </Row>
            <Row title="Police" description="Liste de polices CSS, de la préférée à la moins préférée.">
              <input className="wide" value={s.editorFontFamily} onChange={(e) => set({ editorFontFamily: e.target.value })} />
            </Row>
            <Row title="Taille des tabulations">
              <NumberInput value={s.tabSize} min={1} max={16} onChange={(v) => set({ tabSize: v })} />
            </Row>
            <Row title="Indenter avec des espaces" description="Sinon, des caractères de tabulation sont insérés.">
              <Switch label="Indenter avec des espaces" checked={s.insertSpaces} onChange={(v) => set({ insertSpaces: v })} />
            </Row>
            <Row title="Retour à la ligne automatique">
              <Switch label="Retour à la ligne" checked={s.wordWrap} onChange={(v) => set({ wordWrap: v })} />
            </Row>
            <Row title="Minimap" description="Aperçu du fichier sur le bord droit.">
              <Switch label="Minimap" checked={s.minimap} onChange={(v) => set({ minimap: v })} />
            </Row>
            <Row title="Numéros de ligne">
              <Switch label="Numéros de ligne" checked={s.lineNumbers} onChange={(v) => set({ lineNumbers: v })} />
            </Row>
            <Row title="Afficher les espaces">
              <Switch label="Afficher les espaces" checked={s.renderWhitespace} onChange={(v) => set({ renderWhitespace: v })} />
            </Row>
          </>
        )}

        {section === 'terminal' && (
          <>
            <h2>Terminal</h2>
            <Row title="Taille de police du terminal">
              <NumberInput value={s.terminalFontSize} min={8} max={32} onChange={(v) => set({ terminalFontSize: v })} />
            </Row>
            <Row title="Shell" description="Chemin du shell à lancer (vide = shell par défaut du système). S’applique aux nouveaux terminaux.">
              <input className="wide" value={s.terminalShell} placeholder="/bin/zsh, powershell.exe…" onChange={(e) => set({ terminalShell: e.target.value })} />
            </Row>
          </>
        )}

        {section === 'files' && (
          <>
            <h2>Fichiers</h2>
            <Row title="Dossiers exclus" description="Ignorés par l’ouverture rapide et la recherche. Séparés par des virgules.">
              <input
                className="wide"
                defaultValue={s.excludedFolders.join(', ')}
                onBlur={(e) =>
                  set({
                    excludedFolders: e.target.value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean)
                  })
                }
              />
            </Row>
          </>
        )}

        {section === 'ai' && <AiSettingsSection />}
        {section === 'index' && <IndexSettings />}
        {section === 'mcp' && <McpSettings />}
        {section === 'lsp' && <LspSettings />}

        {section === 'shortcuts' && (
          <>
            <h2>Raccourcis clavier</h2>
            <input className="wide filter" placeholder="Filtrer les commandes…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <table className="shortcuts-table">
              <thead>
                <tr>
                  <th>Commande</th>
                  <th>Raccourci</th>
                </tr>
              </thead>
              <tbody>
                {commands
                  .filter((c) => `${c.category ?? ''} ${c.title}`.toLowerCase().includes(filter.toLowerCase()))
                  .map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.category && <span className="muted">{c.category} : </span>}
                        {c.title}
                      </td>
                      <td>
                        {c.keybinding && <kbd>{formatKeybinding(c.keybinding)}</kbd>}
                        {c.altKeybinding && (
                          <>
                            {' '}
                            <kbd>{formatKeybinding(c.altKeybinding)}</kbd>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
