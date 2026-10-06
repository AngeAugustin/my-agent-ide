import { notify, openPlan, useIde } from '../store/ide'
import { toggleChat, useChat } from '../store/chat'
import { useCodeIndex } from '../store/codeIndex'
import { useLsp } from '../lib/lsp'
import { basename, isInside, relative } from '../lib/paths'
import { runCommandFor, runInTerminal } from '../lib/terminalRegistry'
import { toggleTerminalPanel } from '../store/terminals'
import { Icon } from './Icon'

/** Bandeau de l'espace de travail : fil d'Ariane, état de l'index et du langage, bascules et actions. */
export function WorkspaceToolbar() {
  const workspace = useIde((s) => s.workspace)
  const activeId = useIde((s) => s.activeId)
  const sidebarVisible = useIde((s) => s.sidebarVisible)
  const panelVisible = useIde((s) => s.panelVisible)
  const cursor = useIde((s) => s.cursor)
  const chatVisible = useChat((s) => s.visible)
  const index = useCodeIndex((s) => s.status)
  const lspRunning = useLsp((s) => s.running)

  const file = activeId && !activeId.startsWith('ide://') && !activeId.startsWith('untitled:') ? activeId : null
  const crumbs: string[] = []
  if (workspace) crumbs.push(basename(workspace))
  if (file) {
    const rel = workspace && isInside(workspace, file) ? relative(workspace, file) : file
    crumbs.push(...rel.split(/[\\/]/).filter(Boolean))
  }
  const indexBusy = index?.state === 'scanning' || index?.state === 'embedding'
  const lsp = Object.values(lspRunning)
  const lspLabel = lsp.includes('running') ? ' · LSP' : ''

  const run = () => {
    if (!file) return notify('Ouvrez un fichier à exécuter (JavaScript, TypeScript, Python, shell…).', 'info')
    const command = runCommandFor(file)
    if (!command) return notify('Ce type de fichier ne s’exécute pas directement : utilisez le terminal ou le débogueur (F5).', 'info')
    void runInTerminal(command)
  }

  return (
    <div className="workspace-toolbar">
      <div className="workspace-toolbar-left">
        <Icon name="repo" />
        <nav className="toolbar-crumbs" aria-label="Fil d’Ariane">
          {crumbs.length === 0 && <span className="muted">Aucun dossier ouvert</span>}
          {crumbs.map((c, i) => (
            <span key={i} className={i === crumbs.length - 1 && file ? 'crumb current' : 'crumb'}>
              {i > 0 && <span className="crumb-sep">/</span>}
              {c}
            </span>
          ))}
        </nav>
        {workspace && index && (
          <span className={`toolbar-chip${indexBusy ? ' busy' : index.state === 'error' ? ' error' : ''}`} title="Index du code utilisé par l’IA">
            <span className="dot" />
            {indexBusy ? 'Indexation…' : index.state === 'error' ? 'Index en erreur' : 'Index à jour'}
          </span>
        )}
        {file && cursor && (
          <span className="toolbar-meta">
            {cursor.language}
            {lspLabel}
          </span>
        )}
      </div>
      <div className="workspace-toolbar-right">
        <div className="segmented" role="group" aria-label="Panneaux">
          <button className={sidebarVisible ? 'active' : ''} aria-pressed={sidebarVisible} onClick={() => useIde.setState({ sidebarVisible: !sidebarVisible })} title="Barre latérale (Ctrl+B)">
            <Icon name="files" /> Fichiers
          </button>
          <button className={panelVisible ? 'active' : ''} aria-pressed={panelVisible} onClick={toggleTerminalPanel} title="Terminal (Ctrl+`)">
            <Icon name="terminal" /> Terminal
          </button>
          <button className={chatVisible ? 'active' : ''} aria-pressed={chatVisible} onClick={() => toggleChat()} title="Assistant IA (Ctrl+L)">
            <Icon name="sparkle" /> Agent
          </button>
        </div>
        <span className="toolbar-divider" />
        <button className="toolbar-button" onClick={run} title="Exécuter le fichier actif dans le terminal">
          <Icon name="play" /> Exécuter
        </button>
        <button className="toolbar-button primary" onClick={openPlan} title="Revue des modifications de l’agent (Ctrl+Maj+A)">
          <Icon name="diff-multiple" /> Revue des diffs
        </button>
      </div>
    </div>
  )
}
