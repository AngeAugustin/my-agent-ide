import { useEffect, useRef } from 'react'
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

const DARK_THEME = {
  background: '#18191c',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78'
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
window.api.terminal.onData((id, data) => {
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

  return <div ref={ref} className="terminal-view" style={{ display: visible ? 'block' : 'none' }} />
}

export function TerminalPanel() {
  const { terminals, activeKey } = useTerminals()
  const height = useIde((s) => s.panelHeight)
  const visible = useIde((s) => s.panelVisible)

  // Ouvre un premier terminal quand le panneau est affiché vide.
  useEffect(() => {
    if (visible && terminals.length === 0) newTerminal()
  }, [visible, terminals.length])

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
          <span className="panel-title">Terminal</span>
          {terminals.map((t) => (
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
          <button className="icon-button" title="Nouveau terminal" onClick={() => newTerminal()}>
            <Icon name="add" />
          </button>
          <button className="icon-button" title="Fermer le terminal actif" onClick={() => killTerminal()}>
            <Icon name="trash" />
          </button>
          <button className="icon-button" title="Masquer le panneau" onClick={() => togglePanel(false)}>
            <Icon name="chevron-down" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        {terminals.map((t) => (
          <TerminalView key={t.key} info={t} visible={visible && t.key === activeKey} />
        ))}
      </div>
    </div>
  )
}
