import { openPlan, openSettings, setSidebarWidth, showSidebarView, useIde, PLAN_TAB, SETTINGS_TAB } from '../store/ide'
import { usePlanCount } from '../store/plan'
import { Explorer } from './Explorer'
import { Icon } from './Icon'
import { SearchView } from './SearchView'
import { GitPanel } from './GitPanel'
import { DebugView } from './DebugView'
import { useDebug } from '../store/debug'
import { useGit } from '../store/git'

export function ActivityBar() {
  const view = useIde((s) => s.sidebarView)
  const visible = useIde((s) => s.sidebarVisible)
  const activeId = useIde((s) => s.activeId)
  const section = useIde((s) => s.settingsSection)
  const changes = useGit((s) => s.status?.files.length ?? 0)
  const debugging = useDebug((s) => !!s.session && s.session.status !== 'terminated')
  const planChanges = usePlanCount()

  const settingsActive = activeId === SETTINGS_TAB
  const rulesActive = settingsActive && (section === 'ai' || section === 'index' || section === 'web')

  const item = (key: string, icon: string, label: string, title: string, active: boolean, onClick: () => void, badge = 0) => (
    <button key={key} className={`rail-item${active ? ' active' : ''}`} title={title} aria-label={title} aria-pressed={active} onClick={onClick}>
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
      {badge > 0 && <span className="activity-badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  )
  const view_ = (id: 'explorer' | 'search' | 'git' | 'debug') => () =>
    visible && view === id ? useIde.setState({ sidebarVisible: false }) : showSidebarView(id)

  return (
    <nav className="activity-bar rail">
      <div className="rail-group">
        {item('code', 'code', 'CODE', 'Explorateur (Ctrl+Maj+E)', visible && view === 'explorer', view_('explorer'))}
        {item('search', 'search', 'RECH.', 'Recherche (Ctrl+Maj+F)', visible && view === 'search', view_('search'))}
        {item('git', 'source-control', 'GIT', 'Contrôle de source (Ctrl+Maj+G)', visible && view === 'git', view_('git'), changes)}
        {item('plan', 'type-hierarchy', 'PLAN', 'Plan de l’agent : revue des modifications (Ctrl+Maj+A)', activeId === PLAN_TAB, openPlan, planChanges)}
        {item('rules', 'symbol-ruler', 'RÈGLES', 'Modèles, règles et indexation', rulesActive, () => openSettings('ai'))}
        {item('debug', 'debug-alt', 'DÉBOG.', 'Exécuter et déboguer (Ctrl+Maj+D)', visible && view === 'debug', view_('debug'), debugging ? 1 : 0)}
      </div>
      <div className="rail-group bottom">
        <button className="rail-icon" title="Serveurs MCP" aria-label="Serveurs MCP" onClick={() => openSettings('mcp')}>
          <Icon name="extensions" />
        </button>
        <button className={`rail-icon${settingsActive && !rulesActive ? ' active' : ''}`} title="Paramètres (Ctrl+,)" aria-label="Paramètres" onClick={() => openSettings()}>
          <Icon name="settings-gear" />
        </button>
      </div>
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
      {view === 'explorer' ? <Explorer /> : view === 'search' ? <SearchView /> : view === 'debug' ? <DebugView /> : <GitPanel />}
      <div className="resizer-col" onMouseDown={startResize} onDoubleClick={() => setSidebarWidth(260)} />
    </aside>
  )
}
