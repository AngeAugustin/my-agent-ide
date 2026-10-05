import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DebugVariable } from '@shared/debug'
import {
  addWatch,
  clearConsole,
  editCondition,
  evaluateInConsole,
  isDebugging,
  openLaunchJson,
  pause,
  removeAllBreakpoints,
  removeWatch,
  restartDebugging,
  resume,
  selectConfig,
  selectFrame,
  setBreakpointCondition,
  setBreakpoints,
  startDebugging,
  stepInto,
  stepOut,
  stepOver,
  stopDebugging,
  toggleBreakpointEnabled,
  toggleExpanded,
  useDebug
} from '../store/debug'
import { openFile, useIde } from '../store/ide'
import { basename, relative } from '../lib/paths'
import { Icon } from './Icon'

function Section({ title, children, actions, defaultOpen = true }: { title: string; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="debug-section">
      <div className="git-section-header" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{title}</span>
        {actions && (
          <span className="git-section-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {open && <div className="debug-section-body">{children}</div>}
    </div>
  )
}

/** Arbre de variables (développement à la demande). */
function VariableNode({ variable, depth, path }: { variable: DebugVariable; depth: number; path: string }) {
  const key = `${path}/${variable.name}`
  const open = useDebug((s) => !!s.expanded[key])
  const children = useDebug((s) => (variable.ref ? s.children[variable.ref] : undefined))
  return (
    <>
      <div
        className="debug-var"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => variable.ref && toggleExpanded(key, variable.ref)}
        title={`${variable.name}${variable.type ? ` (${variable.type})` : ''} = ${variable.value}`}
      >
        <Icon name={variable.ref ? (open ? 'chevron-down' : 'chevron-right') : 'blank'} />
        <span className="debug-var-name">{variable.name}</span>
        <span className="debug-var-sep">:</span>
        <span className={`debug-var-value t-${variable.type ?? 'x'}`}>{variable.value}</span>
      </div>
      {open && children?.map((c) => <VariableNode key={`${key}/${c.name}`} variable={c} depth={depth + 1} path={key} />)}
      {open && variable.ref > 0 && !children && <div className="debug-var muted" style={{ paddingLeft: 20 + depth * 12 }}>Chargement…</div>}
    </>
  )
}

function Variables() {
  const scopes = useDebug((s) => s.scopes)
  const expanded = useDebug((s) => s.expanded)
  const children = useDebug((s) => s.children)
  const paused = useDebug((s) => s.session?.status === 'paused')
  if (!paused) return <div className="debug-empty muted">Les variables s’affichent quand le programme est en pause.</div>
  return (
    <>
      {scopes.map((scope) => {
        const key = `scope:${scope.name}`
        const open = !!expanded[key]
        return (
          <div key={key}>
            <div className="debug-var debug-scope" onClick={() => toggleExpanded(key, scope.ref)}>
              <Icon name={open ? 'chevron-down' : 'chevron-right'} />
              <span>{scope.name}</span>
            </div>
            {open && (children[scope.ref] ?? []).map((v) => <VariableNode key={`${key}/${v.name}`} variable={v} depth={1} path={key} />)}
            {open && !children[scope.ref] && <div className="debug-var muted">Chargement…</div>}
          </div>
        )
      })}
    </>
  )
}

function Watches() {
  const watches = useDebug((s) => s.watches)
  const values = useDebug((s) => s.watchValues)
  const [draft, setDraft] = useState('')
  return (
    <>
      {watches.map((w) => {
        const v = values[w]
        return (
          <div key={w} className="debug-var debug-watch" title={v?.error ?? v?.value}>
            <Icon name="eye" />
            <span className="debug-var-name">{w}</span>
            <span className="debug-var-sep">:</span>
            <span className={`debug-var-value${v?.error ? ' error' : ''}`}>{v ? (v.error ?? v.value) : '—'}</span>
            <button className="icon-button small debug-row-action" title="Retirer" onClick={() => removeWatch(w)}>
              <Icon name="close" />
            </button>
          </div>
        )
      })}
      <form
        className="debug-watch-add"
        onSubmit={(e) => {
          e.preventDefault()
          addWatch(draft)
          setDraft('')
        }}
      >
        <input value={draft} placeholder="Ajouter une expression…" onChange={(e) => setDraft(e.target.value)} aria-label="Expression espionnée" />
      </form>
    </>
  )
}

function CallStack() {
  const frames = useDebug((s) => s.frames)
  const frameId = useDebug((s) => s.frameId)
  const ws = useIde((s) => s.workspace) ?? ''
  const [showInternal, setShowInternal] = useState(false)
  if (frames.length === 0) return <div className="debug-empty muted">Pas de pile d’appels (programme en cours d’exécution).</div>
  const shown = showInternal ? frames : frames.filter((f) => f.path || f.id === frameId)
  const hidden = frames.length - shown.length
  return (
    <>
      {shown.map((f) => (
        <div
          key={f.id}
          className={`debug-frame${f.id === frameId ? ' active' : ''}${f.external ? ' external' : ''}`}
          onClick={() => void selectFrame(f.id)}
          title={f.path ? `${f.path}:${f.line}` : 'Code interne'}
        >
          <span className="debug-frame-name">{f.name}</span>
          <span className="muted small">{f.path ? `${f.path.startsWith(ws) ? relative(ws, f.path) : basename(f.path)}:${f.line}` : 'interne'}</span>
        </div>
      ))}
      {(hidden > 0 || showInternal) && (
        <button className="link-button debug-internal-toggle" onClick={() => setShowInternal(!showInternal)}>
          {showInternal ? 'Masquer les cadres internes' : `Afficher ${hidden} cadre(s) interne(s)`}
        </button>
      )}
    </>
  )
}

function ConditionEditor({ path, line, initial }: { path: string; line: number; initial: string }) {
  const [value, setValue] = useState(initial)
  const done = (save: boolean) => {
    if (save) setBreakpointCondition(path, line, value)
    editCondition(path, null)
  }
  return (
    <input
      className="debug-condition"
      autoFocus
      value={value}
      placeholder="Condition (ex. i > 10), Entrée pour valider"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(true)
        if (e.key === 'Escape') done(false)
      }}
      onBlur={() => done(true)}
    />
  )
}

function Breakpoints() {
  const breakpoints = useDebug((s) => s.breakpoints)
  const editing = useDebug((s) => s.editing)
  const ws = useIde((s) => s.workspace) ?? ''
  const entries = Object.entries(breakpoints).flatMap(([path, bps]) => bps.map((bp) => ({ path, bp })))
  if (entries.length === 0) return <div className="debug-empty muted">Cliquez dans la marge à gauche des numéros de ligne (ou F9) pour ajouter un point d’arrêt.</div>
  return (
    <>
      {entries.map(({ path, bp }) => (
        <div key={`${path}:${bp.line}`}>
          <div className="debug-bp" onClick={() => void openFile(path, { line: bp.line, column: 1, preview: true })}>
            <input
              type="checkbox"
              checked={bp.enabled !== false}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleBreakpointEnabled(path, bp.line)}
              aria-label={`Activer le point d’arrêt ligne ${bp.line}`}
            />
            <span className="debug-bp-file">{basename(path)}</span>
            <span className="muted small">{path.startsWith(ws) ? relative(ws, path) : path}</span>
            <span className="debug-bp-line">{bp.line}</span>
            <button className="icon-button small debug-row-action" title="Condition" onClick={(e) => { e.stopPropagation(); editCondition(path, bp.line) }}>
              <Icon name="edit" />
            </button>
            <button
              className="icon-button small debug-row-action"
              title="Retirer"
              onClick={(e) => {
                e.stopPropagation()
                setBreakpoints(path, (breakpoints[path] ?? []).filter((b) => b.line !== bp.line))
              }}
            >
              <Icon name="close" />
            </button>
          </div>
          {bp.condition && !(editing?.path === path && editing.line === bp.line) && <div className="debug-bp-condition muted small">si {bp.condition}</div>}
          {editing?.path === path && editing.line === bp.line && <ConditionEditor path={path} line={bp.line} initial={bp.condition ?? ''} />}
        </div>
      ))}
    </>
  )
}

/** Boutons de contrôle de l'exécution (vue Débogage et barre flottante). */
export function DebugControls({ compact = false }: { compact?: boolean }) {
  const session = useDebug((s) => s.session)
  const active = !!session && session.status !== 'terminated'
  const paused = session?.status === 'paused'
  if (!active) return null
  const btn = (icon: string, title: string, run: () => void, enabled = true, cls = '') => (
    <button className={`icon-button${cls ? ` ${cls}` : ''}`} title={title} aria-label={title} disabled={!enabled} onClick={run}>
      <Icon name={icon} />
    </button>
  )
  return (
    <div className={`debug-controls${compact ? ' compact' : ''}`}>
      {paused ? btn('debug-continue', 'Continuer (F5)', () => void resume()) : btn('debug-pause', 'Suspendre (F6)', () => void pause(), session?.status === 'running')}
      {btn('debug-step-over', 'Pas à pas principal (F10)', () => void stepOver(), paused)}
      {btn('debug-step-into', 'Pas à pas détaillé (F11)', () => void stepInto(), paused)}
      {btn('debug-step-out', 'Pas à pas sortant (Maj+F11)', () => void stepOut(), paused)}
      {btn('debug-restart', 'Redémarrer (Ctrl+Maj+F5)', () => void restartDebugging())}
      {btn('debug-stop', 'Arrêter (Maj+F5)', () => void stopDebugging(), true, 'danger')}
    </div>
  )
}

export function DebugView() {
  const configs = useDebug((s) => s.configs)
  const selected = useDebug((s) => s.selected)
  const session = useDebug((s) => s.session)
  const workspace = useIde((s) => s.workspace)
  const active = !!session && session.status !== 'terminated'
  const status = session
    ? session.status === 'paused'
      ? `En pause${session.reason ? ` (${{ breakpoint: 'point d’arrêt', step: 'pas à pas', exception: 'exception', pause: 'suspendu', entry: 'entrée' }[session.reason] ?? session.reason})` : ''}`
      : session.status === 'running'
        ? 'En cours d’exécution'
        : session.status === 'starting'
          ? 'Démarrage…'
          : 'Terminé'
    : null

  return (
    <div className="debug-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Exécuter et déboguer</span>
        <div className="sidebar-actions">
          <button className="icon-button" title="Ouvrir launch.json" onClick={() => void openLaunchJson()}>
            <Icon name="gear" />
          </button>
        </div>
      </div>
      {!workspace ? (
        <div className="debug-empty muted">Ouvrez un dossier pour déboguer.</div>
      ) : (
        <>
          <div className="debug-start">
            <select value={selected} onChange={(e) => selectConfig(e.target.value)} aria-label="Configuration de débogage" disabled={active}>
              <option value="">Fichier actif (Node.js ou Python)</option>
              {configs.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            {!active && (
              <button className="btn primary" title="Démarrer le débogage (F5)" onClick={() => void startDebugging()}>
                <Icon name="debug-start" /> Démarrer
              </button>
            )}
          </div>
          {active && <DebugControls />}
          {status && (
            <div className={`debug-status${session?.status === 'paused' ? ' paused' : ''}`}>
              {status}
              {session?.description && <div className="small">{session.description}</div>}
            </div>
          )}
          <div className="debug-sections">
            <Section title="Variables">
              <Variables />
            </Section>
            <Section title="Espion">
              <Watches />
            </Section>
            <Section title="Pile des appels">
              <CallStack />
            </Section>
            <Section
              title="Points d’arrêt"
              actions={
                <button className="icon-button small" title="Retirer tous les points d’arrêt" onClick={removeAllBreakpoints}>
                  <Icon name="close-all" />
                </button>
              }
            >
              <Breakpoints />
            </Section>
          </div>
        </>
      )}
    </div>
  )
}

/** Console de débogage (panneau du bas) : sortie du programme et évaluation d'expressions. */
export function DebugConsole({ visible }: { visible: boolean }) {
  const entries = useDebug((s) => s.console)
  const paused = useDebug((s) => s.session?.status === 'paused')
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, visible])

  return (
    <div className="debug-console" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="debug-console-output" ref={listRef}>
        {entries.length === 0 && <div className="muted">La sortie du programme débogué s’affiche ici.</div>}
        {entries.map((e) => (
          <div key={e.id} className={`debug-console-line ${e.kind}`}>
            {e.kind === 'input' && <Icon name="chevron-right" />}
            {e.kind === 'result' && <Icon name="arrow-small-left" />}
            {e.kind === 'result' && e.ref ? <ConsoleObject value={e.text} refId={e.ref} id={e.id} /> : <span>{e.text.replace(/\n$/, '')}</span>}
          </div>
        ))}
      </div>
      <div className="debug-console-input">
        <Icon name="chevron-right" />
        <input
          value={input}
          placeholder={paused ? 'Évaluer une expression dans le contexte en pause…' : isDebugging() ? 'Évaluer une expression…' : 'Démarrez une session de débogage (F5)'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) {
              void evaluateInConsole(input)
              setHistory((h) => [input, ...h.filter((x) => x !== input)].slice(0, 50))
              setIndex(-1)
              setInput('')
            } else if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault()
              const i = Math.min(index + 1, history.length - 1)
              setIndex(i)
              setInput(history[i])
            } else if (e.key === 'ArrowDown' && index >= 0) {
              e.preventDefault()
              const i = index - 1
              setIndex(i)
              setInput(i >= 0 ? history[i] : '')
            }
          }}
          aria-label="Console de débogage"
        />
        <button className="icon-button" title="Effacer la console" onClick={clearConsole}>
          <Icon name="clear-all" />
        </button>
      </div>
    </div>
  )
}

function ConsoleObject({ value, refId, id }: { value: string; refId: number; id: number }) {
  return <VariableNode variable={{ name: value, value: '', ref: refId }} depth={0} path={`console:${id}`} />
}
