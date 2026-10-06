import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { setPanelHeight, togglePanel, useIde } from '../store/ide'
import {
  killTerminal,
  markExited,
  newTerminal,
  setActiveTerminal,
  setPtyId,
  useTerminals,
  type TerminalInfo
} from '../store/terminals'
import { Icon } from './Icon'
import { registerTerminal } from '../lib/terminalRegistry'
import { DebugConsole } from './DebugView'
import { addContext, focusChat } from '../store/chat'
import { ProblemsView, useProblemCount } from './ProblemsView'
import { create } from 'zustand'

const useLocalUrl = create<{ url: string | null }>()(() => ({ url: null }))
const setLocalUrl = (url: string) => useLocalUrl.setState({ url })
import { setPanelTab, useDebug } from '../store/debug'

const DARK_THEME = {
  background: '#0a0e16',
  foreground: '#dfe2ee',
  cursor: '#4cd7f6',
  selectionBackground: '#4cd7f640',
  green: '#4edea3',
  brightGreen: '#4edea3',
  cyan: '#4cd7f6',
  brightCyan: '#acedff',
  red: '#ff6b5f',
  brightRed: '#ffb4ab'
}

const LIGHT_THEME = {
  background: '#f8f8f8',
  foreground: '#333333',
  cursor: '#333333',
  selectionBackground: '#add6ff',
  black: '#000000',
  white: '#a5a5a5',
  brightWhite: '#666666'
}

// Les données du terminal arrivent par un seul canal : on les distribue par identifiant.
const writers = new Map<number, (data: string) => void>()
// Données reçues avant que l'interface ne connaisse l'identifiant du processus (invite du shell).
const early = new Map<number, string[]>()
// Serveurs locaux annoncés dans les terminaux (ex. « http://localhost:5173 ») : lien rapide dans l'en-tête.
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}[^\s"'\x1b]*/g
window.api.terminal.onData((id, data) => {
  const urls = data.replace(/\x1b\[[0-9;]*m/g, '').match(LOCAL_URL)
  if (urls) setLocalUrl(urls[urls.length - 1].replace('0.0.0.0', 'localhost').replace(/[).,;]+$/, ''))
  const writer = writers.get(id)
  if (writer) writer(data)
  else early.set(id, [...(early.get(id) ?? []), data])
})

function attachWriter(id: number, writer: (data: string) => void): void {
  writers.set(id, writer)
  early.get(id)?.forEach(writer)
  early.delete(id)
}
window.api.terminal.onExit((id) => {
  writers.get(id)?.('\r\n\x1b[2m[Processus terminé]\x1b[0m\r\n')
  markExited(id)
})

function TerminalView({ info, visible }: { info: TerminalInfo; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [selectionText, setSelectionText] = useState('')
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyRef = useRef<number | null>(null)
  const settings = useIde((s) => s.settings)

  useEffect(() => {
    const s = useIde.getState().settings
    const term = new Terminal({
      fontFamily: s.editorFontFamily,
      fontSize: s.terminalFontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: s.theme === 'dark' ? DARK_THEME : LIGHT_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      // Le conteneur peut ne pas encore avoir de taille.
    }

    let disposed = false
    const cwd = info.cwd ?? useIde.getState().workspace
    window.api.terminal.create(cwd, term.cols, term.rows).then((id) => {
      if (disposed) {
        window.api.terminal.kill(id)
        return
      }
      ptyRef.current = id
      setPtyId(info.key, id)
      attachWriter(id, (data) => term.write(data))
    }).catch((err) => {
      term.write(`\x1b[31mImpossible de démarrer le terminal : ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
    })

    const dataSub = term.onData((data) => {
      if (ptyRef.current !== null) window.api.terminal.write(ptyRef.current, data)
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ptyRef.current !== null) window.api.terminal.resize(ptyRef.current, cols, rows)
    })

    // Laisse passer les raccourcis globaux de l'IDE au lieu de les envoyer au shell.
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.type !== 'keydown' || !mod) return true
      if (e.code === 'Backquote' || (e.shiftKey && ['KeyP', 'KeyF', 'KeyE'].includes(e.code))) return false
      if (['KeyP', 'KeyB', 'KeyJ'].includes(e.code) && !e.shiftKey && !e.altKey) return false
      // Copier/coller : Ctrl+Maj+C / Ctrl+Maj+V (Ctrl+C reste l'interruption du processus).
      if (e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (e.shiftKey && e.code === 'KeyV') {
        void navigator.clipboard.readText().then((t) => term.paste(t))
        return false
      }
      return true
    })

    const unregister = registerTerminal(info.key, {
      read: (maxLines) => {
        const buf = term.buffer.active
        const lines: string[] = []
        for (let i = Math.max(0, buf.length - maxLines); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
        return lines.join('\n').replace(/\n+$/, '')
      },
      ptyId: () => ptyRef.current,
      paste: (text) => term.paste(text),
      focus: () => term.focus(),
      selection: () => term.getSelection(),
      hasFocus: () => !!ref.current?.contains(document.activeElement)
    })
    const selectionSub = term.onSelectionChange(() => setSelectionText(term.hasSelection() ? term.getSelection().replace(/\s+$/, '') : ''))

    const observer = new ResizeObserver(() => {
      if (ref.current && ref.current.offsetWidth > 0 && ref.current.offsetHeight > 0) {
        try {
          fit.fit()
        } catch {
          // ignoré
        }
      }
    })
    observer.observe(ref.current!)

    return () => {
      disposed = true
      unregister()
      selectionSub.dispose()
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      if (ptyRef.current !== null) writers.delete(ptyRef.current)
      term.dispose()
    }
  }, [info.key])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = settings.terminalFontSize
    term.options.fontFamily = settings.editorFontFamily
    term.options.theme = settings.theme === 'dark' ? DARK_THEME : LIGHT_THEME
    try {
      fitRef.current?.fit()
    } catch {
      // ignoré
    }
  }, [settings.terminalFontSize, settings.editorFontFamily, settings.theme])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignoré
      }
      termRef.current?.focus()
    })
  }, [visible])

  return (
    <div className="terminal-view" style={{ display: visible ? 'block' : 'none' }}>
      <div ref={ref} className="terminal-host" />
      {selectionText && (
        <button
          className="terminal-send-chat"
          title="Joindre la sélection à la conversation (Ctrl+L)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            addContext({ kind: 'snippet', source: 'terminal', text: selectionText })
            focusChat()
          }}
        >
          <Icon name="comment-discussion" /> Envoyer au chat
        </button>
      )}
    </div>
  )
}

export function TerminalPanel() {
  const { terminals, activeKey } = useTerminals()
  const height = useIde((s) => s.panelHeight)
  const visible = useIde((s) => s.panelVisible)
  const panelTab = useDebug((s) => s.panelTab)
  const problemCount = useProblemCount()
  const localUrl = useLocalUrl((s) => s.url)

  // Ouvre un premier terminal quand le panneau est affiché vide.
  useEffect(() => {
    if (visible && panelTab === 'terminal' && terminals.length === 0) newTerminal()
  }, [visible, panelTab, terminals.length])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const onMove = (ev: MouseEvent) => setPanelHeight(startH + (startY - ev.clientY))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing-row')
    }
    document.body.classList.add('resizing-row')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="panel" style={{ height, display: visible ? 'flex' : 'none' }}>
      <div className="resizer-row" onMouseDown={startResize} />
      <div className="panel-header">
        <div className="panel-tabs">
          <button className={`panel-title${panelTab === 'terminal' ? ' active' : ''}`} onClick={() => setPanelTab('terminal')}>
            Terminal
          </button>
          <button className={`panel-title${panelTab === 'debug' ? ' active' : ''}`} onClick={() => setPanelTab('debug')}>
            Console de débogage
          </button>
          <button className={`panel-title${panelTab === 'problems' ? ' active' : ''}`} onClick={() => setPanelTab('problems')}>
            Problèmes {problemCount > 0 && <span className="panel-count">{problemCount}</span>}
          </button>
          {panelTab === 'terminal' && terminals.map((t) => (
            <button
              key={t.key}
              className={`panel-tab${t.key === activeKey ? ' active' : ''}`}
              onClick={() => setActiveTerminal(t.key)}
              title={t.title}
            >
              <Icon name="terminal" /> {t.title}
              <span
                className="panel-tab-close"
                role="button"
                title="Fermer ce terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  killTerminal(t.key)
                }}
              >
                <Icon name="close" />
              </span>
            </button>
          ))}
        </div>
        <div className="panel-actions">
          {localUrl && (
            <button className="panel-url" title={`Ouvrir ${localUrl} dans le navigateur`} onClick={() => window.api.shell.openExternal(localUrl)}>
              <span className="dot" /> {localUrl.replace(/^https?:\/\//, '')}
            </button>
          )}
          {panelTab === 'terminal' && (
            <>
              <button className="icon-button" title="Nouveau terminal" onClick={() => newTerminal()}>
                <Icon name="add" />
              </button>
              <button className="icon-button" title="Fermer le terminal actif" onClick={() => killTerminal()}>
                <Icon name="trash" />
              </button>
            </>
          )}
          <button className="icon-button" title="Masquer le panneau" onClick={() => togglePanel(false)}>
            <Icon name="chevron-down" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        {terminals.map((t) => (
          <TerminalView key={t.key} info={t} visible={visible && panelTab === 'terminal' && t.key === activeKey} />
        ))}
        <DebugConsole visible={visible && panelTab === 'debug'} />
        <ProblemsView visible={visible && panelTab === 'problems'} />
      </div>
    </div>
  )
}
