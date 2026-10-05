import { useEffect } from 'react'
import {
  confirmUnsaved,
  closePalette,
  handleFsChanges,
  initialize,
  setDirty,
  useIde
} from './store/ide'
import { loadAi } from './store/ai'
import { initCodeIndex } from './store/codeIndex'
import { initGit } from './store/git'
import { initMcp } from './store/mcp'
import { initWeb } from './store/web'
import { initDebug } from './store/debug'
import { initLsp } from './lib/lsp'
import { commands, runCommand } from './lib/commands'
import { onDirtyChange } from './lib/editorModels'
import { matchesKeybinding } from './lib/keybindings'
import { basename } from './lib/paths'
import { ActivityBar, Sidebar } from './components/Sidebar'
import { EditorArea } from './components/EditorArea'
import { TerminalPanel } from './components/TerminalPanel'
import { StatusBar } from './components/StatusBar'
import { CommandPalette } from './components/CommandPalette'
import { ContextMenu } from './components/ContextMenu'
import { Dialog, Toasts } from './components/Overlays'
import { ChatPanel } from './components/ChatPanel'
import { useChat } from './store/chat'

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useIde.getState()
      if (state.dialog) return
      if (state.palette.open && e.key === 'Escape') {
        closePalette()
        return
      }
      for (const cmd of commands) {
        const bindings = [cmd.keybinding, cmd.altKeybinding].filter(Boolean) as string[]
        if (!bindings.some((b) => matchesKeybinding(e, b))) continue
        if (cmd.when && !cmd.when()) continue
        e.preventDefault()
        e.stopPropagation()
        void cmd.run()
        return
      }
    }
    // Phase de capture : passe avant Monaco et xterm.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

function useWindowTitle(): void {
  const workspace = useIde((s) => s.workspace)
  const active = useIde((s) => s.tabs.find((t) => t.id === s.activeId))
  useEffect(() => {
    const parts = [active ? `${active.dirty ? '● ' : ''}${active.title}` : null, workspace ? basename(workspace) : null, 'My Agent IDE']
    const title = parts.filter(Boolean).join(' — ')
    document.title = title
    window.api.app.setTitle(title)
  }, [workspace, active])
}

export function App() {
  const ready = useIde((s) => s.ready)
  const theme = useIde((s) => s.settings.theme)
  const sidebarVisible = useIde((s) => s.sidebarVisible)
  const chatVisible = useChat((s) => s.visible)

  useGlobalShortcuts()
  useWindowTitle()

  useEffect(() => {
    void initialize()
      .then(() => {
        initCodeIndex()
        initGit()
        initMcp()
        initWeb()
        initDebug()
        initLsp()
        return loadAi()
      })
      .catch(() => undefined)
    const offs = [
      onDirtyChange((path, dirty) => setDirty(path, dirty)),
      window.api.fs.onChange(handleFsChanges),
      window.api.app.onMenuCommand(runCommand),
      window.api.app.onBeforeClose(async () => {
        if (await confirmUnsaved()) window.api.app.confirmClose()
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  if (!ready) return <div className="app loading" />

  return (
    <div className="app">
      <div className="main">
        <ActivityBar />
        {sidebarVisible && <Sidebar />}
        <div className="workbench">
          <EditorArea />
          <TerminalPanel />
        </div>
        {chatVisible && <ChatPanel />}
      </div>
      <StatusBar />
      <CommandPalette />
      <ContextMenu />
      <Dialog />
      <Toasts />
    </div>
  )
}
