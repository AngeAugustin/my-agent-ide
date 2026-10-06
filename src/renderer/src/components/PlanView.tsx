import { useEffect, useMemo, useState } from 'react'
import { diffLines } from '@shared/diff'
import { describeTool, readCurrent } from '../lib/agentTools'
import { basename, dirname, isInside, relative } from '../lib/paths'
import { runInTerminal } from '../lib/terminalRegistry'
import { revertFile } from '../store/agent'
import { focusChat, openConversation, setMode, newConversation, useChat } from '../store/chat'
import { refreshGit, useGit } from '../store/git'
import { notify, openFile, reportError, showSidebarView, useIde } from '../store/ide'
import { planConversation, planFiles, planTurns, type PlanFile } from '../store/plan'
import { openAgentDiff } from '../store/review'
import { Icon } from './Icon'

interface FileState extends PlanFile {
  current: string | null
  added: number
  removed: number
  /** Premières lignes modifiées (aperçu). */
  preview: Array<{ kind: '+' | '-'; text: string }>
}

const kindOf = (f: FileState) => (f.original === null ? 'new' : f.current === null ? 'deleted' : 'modified')
const KIND_LABEL = { new: 'NOUVEAU', deleted: 'SUPPRIMÉ', modified: 'MODIFIÉ' } as const

async function loadState(files: PlanFile[]): Promise<FileState[]> {
  return Promise.all(
    files.map(async (f) => {
      let current: string | null = null
      try {
        current = (await window.api.fs.exists(f.path)) ? await readCurrent(f.path) : null
      } catch {
        current = null
      }
      const a = f.original === null ? [] : f.original.split('\n')
      const b = current === null ? [] : current.split('\n')
      let added = 0
      let removed = 0
      const preview: FileState['preview'] = []
      for (const op of diffLines(a, b)) {
        if (op.type === 'insert') {
          added += op.count
          for (const line of b.slice(op.newStart, op.newStart + op.count)) if (preview.length < 7) preview.push({ kind: '+', text: line })
        } else if (op.type === 'delete') {
          removed += op.count
          for (const line of a.slice(op.oldStart, op.oldStart + op.count)) if (preview.length < 7) preview.push({ kind: '-', text: line })
        }
      }
      return { ...f, current, added, removed, preview }
    })
  )
}

/** Commande de test probable du projet. */
async function testCommand(ws: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await window.api.fs.readFile(`${ws}/package.json`)) as { scripts?: Record<string, string> }
    if (pkg.scripts?.test) return 'npm test'
  } catch {
    // pas de package.json
  }
  for (const [file, cmd] of [
    ['pytest.ini', 'pytest'],
    ['pyproject.toml', 'pytest'],
    ['Cargo.toml', 'cargo test'],
    ['go.mod', 'go test ./...']
  ]) {
    if (await window.api.fs.exists(`${ws}/${file}`)) return cmd
  }
  return null
}

/** Vue « Plan » : revue des modifications de l'agent, journal d'exécution et validation groupée. */
export function PlanView() {
  const conv = useChat((s) => planConversation(s))
  const ws = useIde((s) => s.workspace) ?? ''
  const branch = useGit((s) => s.status?.branch)
  const isRepo = useGit((s) => !!s.status?.isRepo)
  const streaming = useChat((s) => !!s.streamingId)
  const files = useMemo(() => planFiles(conv), [conv])
  const turns = useMemo(() => planTurns(conv), [conv])
  const [states, setStates] = useState<FileState[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadState(files).then((s) => {
      if (!cancelled) setStates(s)
    })
    return () => {
      cancelled = true
    }
  }, [files, conv?.updatedAt])

  useEffect(() => {
    setSelected(Object.fromEntries(files.map((f) => [f.path, true])))
  }, [files])

  const rel = (p: string) => (ws && isInside(ws, p) ? relative(ws, p).split('\\').join('/') : p)
  const added = states.reduce((n, s) => n + s.added, 0)
  const removed = states.reduce((n, s) => n + s.removed, 0)
  const runs = turns.flatMap((t) => (t.steps ?? []).flatMap((s) => s.tools))
  const commands = runs.filter((r) => r.call.name === 'run_command')
  const failed = runs.filter((r) => r.status === 'error').length
  const chosen = states.filter((s) => selected[s.path])
  const lastTurn = turns.at(-1)
  const status = lastTurn?.status === 'streaming' ? 'En cours' : lastTurn?.status === 'error' ? 'Erreur' : lastTurn?.status === 'stopped' ? 'Interrompu' : 'Terminé'

  if (!conv || files.length === 0) {
    return (
      <div className="plan-view plan-empty">
        <Icon name="type-hierarchy" />
        <h2>Aucune modification de l’agent à revoir</h2>
        <p className="muted">
          Confiez une tâche à l’agent (<kbd>Ctrl+I</kbd>) : chaque fichier qu’il modifie apparaît ici, avec son diff, le journal de ses actions et une
          validation groupée.
        </p>
        <button
          className="btn primary"
          onClick={() => {
            newConversation()
            setMode('agent')
            focusChat()
          }}
        >
          <Icon name="sparkle" /> Nouvelle tâche pour l’agent
        </button>
      </div>
    )
  }

  const stage = async () => {
    if (!isRepo) return notify('Ce dossier n’est pas un dépôt Git.', 'info')
    setBusy(true)
    try {
      await window.api.git.stage(ws, chosen.map((s) => rel(s.path)))
      await refreshGit()
      notify(`${chosen.length} fichier(s) indexé(s) pour le prochain commit.`, 'success')
    } catch (err) {
      reportError('Indexation impossible', err)
    } finally {
      setBusy(false)
    }
  }

  const revert = async () => {
    setBusy(true)
    try {
      for (const s of chosen) await revertFile(conv.id, s.path, s.original)
      setStates(await loadState(files))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="plan-view">
      <div className="plan-header">
        <div className="plan-title-block">
          <span className="plan-title-icon">
            <Icon name="type-hierarchy" />
          </span>
          <div>
            <div className="plan-title">
              Plan de l’agent : {conv.title || 'tâche'}
              <span className={`plan-status ${lastTurn?.status ?? 'done'}`}>
                <span className="dot" /> {status}
              </span>
            </div>
            <div className="plan-subtitle">
              {files.length} fichier{files.length > 1 ? 's' : ''} impacté{files.length > 1 ? 's' : ''} · <span className="diff-plus">+{added}</span>{' '}
              <span className="diff-minus">-{removed}</span>
              {branch && <> · Branche : {branch}</>}
            </div>
          </div>
        </div>
        <div className="plan-actions">
          <button className="toolbar-button" onClick={() => openConversation(conv.id)} title="Afficher la conversation">
            <Icon name="comment-discussion" /> Conversation
          </button>
          <button
            className="toolbar-button"
            onClick={async () => {
              for (const s of states) await openAgentDiff(conv.id, s.path, s.original)
            }}
          >
            <Icon name="diff-multiple" /> Revoir tous les diffs
          </button>
          <button
            className="toolbar-button"
            onClick={async () => {
              const cmd = await testCommand(ws)
              if (!cmd) return notify('Aucune commande de test détectée (package.json, pytest, cargo, go).', 'info')
              void runInTerminal(cmd)
            }}
          >
            <Icon name="beaker" /> Lancer les tests
          </button>
          {isRepo && (
            <button className="toolbar-button primary" onClick={() => showSidebarView('git')}>
              <Icon name="git-commit" /> Commit
            </button>
          )}
        </div>
      </div>
      <div className="plan-body">
        <div className="plan-canvas">
          {states.map((s) => {
            const kind = kindOf(s)
            return (
              <div key={s.path} className={`plan-card k-${kind}`}>
                <div className="plan-card-header">
                  <Icon name={kind === 'new' ? 'new-file' : kind === 'deleted' ? 'trash' : 'code'} />
                  <span className="plan-card-name" title={s.path}>
                    {basename(s.path)}
                  </span>
                  <span className={`plan-badge k-${kind}`}>{KIND_LABEL[kind]}</span>
                </div>
                <div className="plan-card-meta">
                  <span>
                    <span className="diff-plus">+{s.added}</span> <span className="diff-minus">-{s.removed}</span>
                  </span>
                  <span className="muted">{rel(dirname(s.path)) || '.'}</span>
                </div>
                <div className="plan-card-diff">
                  {s.preview.length === 0 && <div className="muted">Aucune différence.</div>}
                  {s.preview.map((l, i) => (
                    <div key={i} className={`plan-diff-line ${l.kind === '+' ? 'add' : 'del'}`}>
                      <span>{l.kind}</span> {l.text || ' '}
                    </div>
                  ))}
                </div>
                <div className="plan-card-footer">
                  <button className="link-button" onClick={() => void openAgentDiff(conv.id, s.path, s.original)}>
                    <Icon name="diff" /> Diff
                  </button>
                  {s.current !== null && (
                    <button className="link-button" onClick={() => void openFile(s.path)}>
                      <Icon name="go-to-file" /> Ouvrir
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <aside className="plan-drawer">
          <div className="plan-drawer-header">
            <span className={`dot${streaming ? ' live' : ''}`} /> Journal d’exécution de l’agent
          </div>
          <div className="plan-stats">
            <div>
              <div className="plan-stat-label">
                <Icon name="files" /> FICHIERS
              </div>
              <div className="plan-stat-value">{files.length} modifié(s)</div>
              <div className="plan-stat-sub">
                +{added} / -{removed} lignes
              </div>
            </div>
            <div>
              <div className="plan-stat-label">
                <Icon name="terminal" /> COMMANDES
              </div>
              <div className="plan-stat-value">{commands.length} lancée(s)</div>
              <div className={`plan-stat-sub${failed ? ' error' : ''}`}>{failed ? `${failed} action(s) en erreur` : 'Aucune erreur'}</div>
            </div>
          </div>
          <div className="plan-log">
            {runs.length === 0 && <div className="muted small">Aucune action.</div>}
            {runs.map((r, i) => {
              const { icon, label } = describeTool(r.call)
              return (
                <div key={r.call.id || i} className={`plan-log-item ${r.status}`}>
                  <Icon
                    name={r.status === 'running' ? 'loading' : r.status === 'error' || r.status === 'denied' ? 'error' : r.status === 'done' ? 'pass' : icon}
                    className={r.status === 'running' ? 'codicon-modifier-spin' : undefined}
                  />
                  <span title={label}>{label}</span>
                </div>
              )
            })}
          </div>
          <div className="plan-approvals">
            <div className="plan-approvals-header">
              <span>
                VALIDATION GROUPÉE ({chosen.length}/{states.length})
              </span>
              <button
                className="link-button"
                onClick={() => setSelected(Object.fromEntries(states.map((s) => [s.path, chosen.length !== states.length])))}
              >
                {chosen.length === states.length ? 'Tout désélectionner' : 'Tout sélectionner'}
              </button>
            </div>
            {states.map((s) => {
              const kind = kindOf(s)
              return (
                <label key={s.path} className="plan-approval">
                  <input type="checkbox" checked={!!selected[s.path]} onChange={(e) => setSelected((x) => ({ ...x, [s.path]: e.target.checked }))} />
                  <span className="plan-approval-name">{basename(s.path)}</span>
                  <span className={`plan-approval-kind k-${kind}`}>{kind === 'new' ? 'Nouveau' : kind === 'deleted' ? 'Supprimé' : 'Modifié'}</span>
                </label>
              )
            })}
            <div className="plan-approval-actions">
              <button className="btn primary" disabled={busy || chosen.length === 0 || streaming || !isRepo} onClick={() => void stage()} title={isRepo ? '' : 'Dossier sans dépôt Git'}>
                <Icon name="check-all" /> Indexer la sélection
              </button>
              <button className="btn danger" disabled={busy || chosen.length === 0 || streaming} onClick={() => void revert()}>
                <Icon name="discard" /> Annuler la sélection
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
