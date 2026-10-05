import { openSettings, setSidebarWidth, showSidebarView, useIde, SETTINGS_TAB } from '../store/ide'
import { toggleTerminalPanel } from '../store/terminals'
import { toggleChat, useChat } from '../store/chat'
import { Explorer } from './Explorer'
import { Icon } from './Icon'
import { SearchView } from './SearchView'
import { GitPanel } from './GitPanel'
import { useGit } from '../store/git'

export function ActivityBar() {
  const view = useIde((s) => s.sidebarView)
  const visible = useIde((s) => s.sidebarVisible)
  const settingsActive = useIde((s) => s.activeId === SETTINGS_TAB)
  const panelVisible = useIde((s) => s.panelVisible)
  const chatVisible = useChat((s) => s.visible)

  const changes = useGit((s) => s.status?.files.length ?? 0)
  const item = (id: 'explorer' | 'search' | 'git', icon: string, title: string, badge = 0) => (
    <button
      className={`activity-item${visible && view === id ? ' active' : ''}`}
      title={title}
      aria-label={title}
      onClick={() => (visible && view === id ? useIde.setState({ sidebarVisible: false }) : showSidebarView(id))}
    >
      <Icon name={icon} />
      {badge > 0 && <span className="activity-badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  )

  return (
    <nav className="activity-bar">
      {item('explorer', 'files', 'Explorateur (Ctrl+Maj+E)')}
      {item('search', 'search', 'Recherche (Ctrl+Maj+F)')}
      {item('git', 'source-control', 'Contrôle de source (Ctrl+Maj+G)', changes)}
      <button className={`activity-item${panelVisible ? ' active' : ''}`} title="Terminal (Ctrl+`)" aria-label="Terminal" onClick={toggleTerminalPanel}>
        <Icon name="terminal" />
      </button>
      <button className={`activity-item${chatVisible ? ' active' : ''}`} title="Chat IA (Ctrl+L)" aria-label="Chat IA" onClick={() => toggleChat()}>
        <Icon name="comment-discussion" />
      </button>
      <div className="activity-spacer" />
      <button className={`activity-item${settingsActive ? ' active' : ''}`} title="Paramètres (Ctrl+,)" aria-label="Paramètres" onClick={() => openSettings()}>
        <Icon name="settings-gear" />
      </button>
    </nav>
  )
}

export function Sidebar() {
  const view = useIde((s) => s.sidebarView)
  const width = useIde((s) => s.sidebarWidth)

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) => setSidebarWidth(startW + ev.clientX - startX)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing-col')
    }
    document.body.classList.add('resizing-col')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside className="sidebar" style={{ width }}>
      {view === 'explorer' ? <Explorer /> : view === 'search' ? <SearchView /> : <GitPanel />}
      <div className="resizer-col" onMouseDown={startResize} onDoubleClick={() => setSidebarWidth(260)} />
    </aside>
  )
}
