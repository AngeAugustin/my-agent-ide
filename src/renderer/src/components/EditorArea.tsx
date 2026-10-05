import { useState } from 'react'
import {
  closeOtherTabs,
  closeTab,
  moveTab,
  openWorkspace,
  pickWorkspace,
  pinTab,
  revealInExplorer,
  setActive,
  showSidebarView,
  SETTINGS_TAB,
  useIde,
  type Tab
} from '../store/ide'
import { commands, runCommand } from '../lib/commands'
import { fileIcon } from '../lib/fileIcons'
import { formatKeybinding } from '../lib/keybindings'
import { basename, relative } from '../lib/paths'
import { CodeEditor } from './CodeEditor'
import { showContextMenu } from './ContextMenu'
import { Icon } from './Icon'
import { DebugControls } from './DebugView'
import { SettingsPage } from './SettingsPage'
import { DiffReview } from './DiffReview'

function TabItem({ tab, index }: { tab: Tab; index: number }) {
  const active = useIde((s) => s.activeId === tab.id)
  const workspace = useIde((s) => s.workspace)
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null)

  const icon =
    tab.kind === 'settings'
      ? { icon: 'settings-gear', color: 'var(--fg-muted)' }
      : tab.kind === 'diff'
        ? { icon: 'diff', color: 'var(--accent)' }
      : tab.kind === 'untitled'
        ? { icon: 'file', color: 'var(--fg-muted)' }
        : fileIcon(tab.id)

  return (
    <div
      className={`tab${active ? ' active' : ''}${tab.preview ? ' preview' : ''}${dropSide ? ` drop-${dropSide}` : ''}`}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          void closeTab(tab.id)
        } else if (e.button === 0) setActive(tab.id)
      }}
      onDoubleClick={() => pinTab(tab.id)}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: 'Fermer', keybinding: 'Mod+W', run: () => closeTab(tab.id) },
          { label: 'Fermer les autres', run: () => closeOtherTabs(tab.id) },
          { label: 'Fermer tout', run: () => runCommand('editor.closeAll') },
          { separator: true },
          ...(tab.kind === 'file'
            ? [
                { label: 'Copier le chemin', run: () => navigator.clipboard.writeText(tab.id) },
                ...(workspace ? [{ label: 'Copier le chemin relatif', run: () => navigator.clipboard.writeText(relative(workspace, tab.id)) }] : []),
                { label: 'Révéler dans l’explorateur', run: () => { showSidebarView('explorer'); void revealInExplorer(tab.id) } },
                { label: 'Révéler dans le gestionnaire de fichiers', run: () => window.api.shell.revealInFolder(tab.id) },
                { separator: true }
              ]
            : []),
          { label: 'Garder ouvert', disabled: !tab.preview, run: () => pinTab(tab.id) }
        ])
      }
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-ide-tab', tab.id)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-ide-tab')) return
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        setDropSide(e.clientX < rect.left + rect.width / 2 ? 'left' : 'right')
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('application/x-ide-tab')
        const side = dropSide
        setDropSide(null)
        if (!id || id === tab.id) return
        const from = useIde.getState().tabs.findIndex((t) => t.id === id)
        let to = side === 'right' ? index + 1 : index
        if (from < to) to--
        moveTab(id, to)
      }}
      title={tab.kind === 'file' ? tab.id : tab.title}
    >
      <Icon name={icon.icon} color={icon.color} />
      <span className="tab-title">{tab.title}</span>
      <button
        className={`tab-close${tab.dirty ? ' dirty' : ''}`}
        title={tab.dirty ? 'Non enregistré — fermer' : 'Fermer'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          void closeTab(tab.id)
        }}
      >
        <Icon name={tab.dirty ? 'circle-filled' : 'close'} />
      </button>
    </div>
  )
}

function Breadcrumbs({ path }: { path: string }) {
  const workspace = useIde((s) => s.workspace)
  const rel = workspace ? relative(workspace, path) : path
  const parts = rel.split(/[\\/]/).filter(Boolean)
  return (
    <div className="breadcrumbs">
      {parts.map((p, i) => (
        <span key={i} className="crumb">
          {i > 0 && <Icon name="chevron-right" className="crumb-sep" />}
          {i === parts.length - 1 && <Icon name={fileIcon(path).icon} color={fileIcon(path).color} />}
          <span>{p}</span>
        </span>
      ))}
    </div>
  )
}

function Welcome() {
  const recent = useIde((s) => s.recentWorkspaces)
  const workspace = useIde((s) => s.workspace)
  const shortcuts = ['chat.toggle', 'editor.inlineEdit', 'palette.commands', 'palette.files', 'view.search', 'view.toggleTerminal', 'settings.open']
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>My Agent IDE</h1>
        <p className="muted">L’éditeur de code propulsé par l’IA, avec vos propres clés API.</p>
        <div className="welcome-columns">
          <section>
            <h2>Démarrer</h2>
            {!workspace && (
              <button className="link-button" onClick={pickWorkspace}>
                <Icon name="folder-opened" /> Ouvrir un dossier…
              </button>
            )}
            <button className="link-button" onClick={() => runCommand('file.new')}>
              <Icon name="new-file" /> Nouveau fichier
            </button>
            <button className="link-button" onClick={() => runCommand('file.open')}>
              <Icon name="go-to-file" /> Ouvrir un fichier…
            </button>
            <button className="link-button" onClick={() => runCommand('settings.open')}>
              <Icon name="settings-gear" /> Paramètres
            </button>
            {recent.length > 0 && (
              <>
                <h2>Récents</h2>
                {recent.slice(0, 6).map((r) => (
                  <button key={r} className="link-button recent" title={r} onClick={() => openWorkspace(r)}>
                    <Icon name="folder" /> {basename(r)} <span className="muted small">{r}</span>
                  </button>
                ))}
              </>
            )}
          </section>
          <section>
            <h2>Raccourcis utiles</h2>
            <dl className="shortcut-list">
              {shortcuts.map((id) => {
                const c = commands.find((c) => c.id === id)!
                return (
                  <div key={id}>
                    <dt>{c.title}</dt>
                    <dd>
                      <kbd>{formatKeybinding(c.keybinding!)}</kbd>
                    </dd>
                  </div>
                )
              })}
            </dl>
          </section>
        </div>
      </div>
    </div>
  )
}

export function EditorArea() {
  const tabs = useIde((s) => s.tabs)
  const activeId = useIde((s) => s.activeId)
  const active = tabs.find((t) => t.id === activeId)
  const editorPath = active && (active.kind === 'file' || active.kind === 'untitled') ? active.id : null

  return (
    <div className="editor-area">
      <div className="debug-floating">
        <DebugControls compact />
      </div>
      {tabs.length > 0 && (
        <div className="tab-bar" onDoubleClick={(e) => e.target === e.currentTarget && runCommand('file.new')}>
          {tabs.map((t, i) => (
            <TabItem key={t.id} tab={t} index={i} />
          ))}
        </div>
      )}
      {active?.kind === 'file' && <Breadcrumbs path={active.id} />}
      <div className="editor-body">
        <div className="editor-host" style={{ display: editorPath ? 'block' : 'none' }}>
          <CodeEditor path={editorPath} />
        </div>
        {activeId === SETTINGS_TAB && <SettingsPage />}
        {active?.kind === 'diff' && <DiffReview key={active.id} id={active.id} />}
        {!active && <Welcome />}
      </div>
    </div>
  )
}
