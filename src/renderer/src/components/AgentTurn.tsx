import { useState } from 'react'
import type { AgentToolRun, AssistantTurn, UserTurn } from '../store/chat'
import { retryLast, useChat } from '../store/chat'
import { answerApproval, changedFiles, restoreCheckpoint, revertFile, toolPath, useAgent } from '../store/agent'
import { openAgentDiff } from '../store/review'
import { modelLabel } from '../store/ai'
import { describeTool } from '../lib/agentTools'
import { formatTokens } from '../lib/ai'
import { relative } from '../lib/paths'
import { openFile, useIde } from '../store/ide'
import { Markdown } from './Markdown'
import { Icon } from './Icon'

const STATUS_ICON: Record<AgentToolRun['status'], { icon: string; cls: string; title: string }> = {
  pending: { icon: 'circle-large-outline', cls: 'muted', title: 'En attente' },
  approval: { icon: 'shield', cls: 'warning', title: 'En attente de votre accord' },
  running: { icon: 'loading', cls: 'running', title: 'En cours' },
  done: { icon: 'pass', cls: 'ok', title: 'Terminé' },
  error: { icon: 'error', cls: 'error', title: 'Erreur' },
  denied: { icon: 'circle-slash', cls: 'error', title: 'Refusé' },
  skipped: { icon: 'debug-step-over', cls: 'muted', title: 'Non exécuté' }
}

function ToolRunView({ convId, run, turnId, stepId, index }: { convId: string; run: AgentToolRun; turnId: string; stepId: string; index: number }) {
  const [open, setOpen] = useState(false)
  const approval = useAgent((s) => s.approval)
  const { icon, label } = describeTool(run.call)
  const st = STATUS_ICON[run.status]
  const isCommand = run.call.name === 'run_command'
  const isMcp = run.call.name.startsWith('mcp__')
  const waiting = run.status === 'approval' && approval?.turnId === turnId && approval.stepId === stepId && approval.index === index
  const path = toolPath(run.call.name, run.call.input)
  const output = run.status === 'running' && run.live ? run.live : run.output

  return (
    <div className={`tool-run ${run.status}`}>
      <div className="tool-run-header" onClick={() => output && setOpen((v) => !v)} role={output ? 'button' : undefined}>
        <Icon name={st.icon} className={`tool-status ${st.cls}${run.status === 'running' ? ' codicon-modifier-spin' : ''}`} title={st.title} />
        <Icon name={icon} />
        <span className={`tool-label${isCommand ? ' mono' : ''}`} title={label}>
          {label}
        </span>
        {run.summary && (run.summary.added !== undefined || run.summary.removed !== undefined) && (
          <span className="diff-stats small">
            <span className="added">+{run.summary.added ?? 0}</span> <span className="removed">−{run.summary.removed ?? 0}</span>
          </span>
        )}
        {isCommand && run.summary?.exitCode !== undefined && run.summary.exitCode !== null && (
          <span className={`small ${run.summary.exitCode === 0 ? 'muted' : 'error-text'}`}>code {run.summary.exitCode}</span>
        )}
        {path && run.status === 'done' && run.call.name !== 'delete_file' && (
          <button
            className="icon-button"
            title="Ouvrir le fichier"
            onClick={(e) => {
              e.stopPropagation()
              void openFile(path)
            }}
          >
            <Icon name="go-to-file" />
          </button>
        )}
        {output && <Icon name={open ? 'chevron-down' : 'chevron-right'} className="muted" />}
      </div>
      {waiting && (
        <div className="approval">
          <div className="approval-text">
            <Icon name="shield" />{' '}
            {isMcp ? (
              <>L’agent veut utiliser cet outil MCP :</>
            ) : (
              <>
                L’agent veut exécuter cette commande dans <code>{useIde.getState().workspace}</code> :
              </>
            )}
          </div>
          <pre className="approval-command">{approval!.command}</pre>
          <div className="approval-actions">
            <button className="btn danger" onClick={() => answerApproval('deny')}>
              Refuser
            </button>
            <button
              className="btn"
              title={isMcp ? 'Exécuter désormais les outils de ce serveur sans confirmation' : 'Ajouter cette commande exacte à la liste des commandes autorisées'}
              onClick={() => answerApproval('always')}
            >
              {isMcp ? 'Toujours autoriser ce serveur' : 'Toujours autoriser'}
            </button>
            <button className="btn primary" onClick={() => answerApproval('run')} autoFocus>
              <Icon name="play" /> Exécuter
            </button>
          </div>
        </div>
      )}
      {open && output && <pre className="tool-output">{output}</pre>}
      {!open && run.status === 'running' && run.live && <pre className="tool-output live">{run.live.split('\n').slice(-6).join('\n')}</pre>}
    </div>
  )
}

/** Liste des sous-tâches tenue par l'agent. */
function TodoCard({ todos }: { todos: Array<{ text: string; done: boolean }> }) {
  const done = todos.filter((t) => t.done).length
  return (
    <div className="todo-card">
      <div className="todo-card-header">
        <span>
          <Icon name="checklist" /> Sous-tâches
        </span>
        <span className="muted">
          {done} sur {todos.length} terminée(s)
        </span>
      </div>
      {todos.map((t, i) => (
        <div key={i} className={`todo-item${t.done ? ' done' : ''}`}>
          <span className="todo-check">{t.done && <Icon name="check" />}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export function AgentAssistantTurn({ convId, turn, last }: { convId: string; turn: AssistantTurn; last: boolean }) {
  const streaming = turn.status === 'streaming'
  const [showReasoning, setShowReasoning] = useState<Record<string, boolean>>({})
  return (
    <div className="chat-message assistant agent">
      {(turn.steps ?? []).map((step, si) => (
        <div key={step.id} className="agent-step">
          {step.reasoning && (
            <div className="reasoning">
              <button className="reasoning-toggle" onClick={() => setShowReasoning((r) => ({ ...r, [step.id]: !r[step.id] }))}>
                <Icon name={showReasoning[step.id] ? 'chevron-down' : 'chevron-right'} /> Réflexion
              </button>
              {showReasoning[step.id] && <div className="reasoning-text">{step.reasoning}</div>}
            </div>
          )}
          {step.text && <Markdown text={step.text} streaming={streaming && si === (turn.steps?.length ?? 0) - 1} />}
          {step.tools.map((r, i) => (
            <ToolRunView key={r.call.id || i} convId={convId} run={r} turnId={turn.id} stepId={step.id} index={i} />
          ))}
        </div>
      ))}
      {turn.todos && turn.todos.length > 0 && <TodoCard todos={turn.todos} />}
      {streaming && (turn.steps?.length ?? 0) > 0 && !turn.steps!.at(-1)!.text && turn.steps!.at(-1)!.tools.length === 0 && (
        <div className="typing">
          <span />
          <span />
          <span />
        </div>
      )}
      {turn.notices.map((n, i) => (
        <div key={i} className="chat-notice">
          <Icon name="info" /> {n}
        </div>
      ))}
      {turn.status === 'error' && (
        <div className="chat-error">
          <Icon name="error" /> <span>{turn.error}</span>
          {last && (
            <button className="btn" onClick={() => retryLast()}>
              Reprendre
            </button>
          )}
        </div>
      )}
      {turn.status === 'stopped' && <div className="chat-notice">Agent arrêté.</div>}
      {!streaming && (
        <div className="message-footer">
          <span className="muted small">
            {modelLabel(turn.model)} · {turn.steps?.length ?? 0} étape(s)
            {turn.usage ? ` · ${formatTokens(turn.usage.inputTokens)} → ${formatTokens(turn.usage.outputTokens)} jetons` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

/** Fichiers modifiés par l'agent pendant un tour, avec diff et annulation. */
export function ChangedFiles({ convId, turn }: { convId: string; turn: UserTurn }) {
  const files = changedFiles(turn)
  const root = useIde((s) => s.workspace) ?? ''
  const streaming = useChat((s) => !!s.streamingId)
  if (files.length === 0) return null
  const restored = !!turn.checkpoint?.restored
  return (
    <div className={`changed-files${restored ? ' restored' : ''}`}>
      <div className="changed-files-header">
        <Icon name="files" />
        <span>
          {files.length} fichier(s) modifié(s) par l’agent{restored ? ' — restaurés' : ''}
        </span>
        {!restored && (
          <button
            className="btn small-btn"
            disabled={streaming}
            title="Remettre tous les fichiers dans leur état d’avant cette demande (et des suivantes)"
            onClick={() => restoreCheckpoint(convId, turn.id)}
          >
            <Icon name="history" /> Restaurer ce point
          </button>
        )}
      </div>
      {!restored &&
        files.map(({ path, original }) => (
          <div key={path} className="changed-file">
            <Icon name={original === null ? 'diff-added' : 'diff-modified'} className={original === null ? 'added' : 'modified'} />
            <span className="changed-file-path" title={path}>
              {relative(root, path)}
            </span>
            <button className="icon-button" title="Voir les différences" onClick={() => openAgentDiff(convId, path, original)}>
              <Icon name="diff" />
            </button>
            <button className="icon-button" title="Annuler la modification de ce fichier" disabled={streaming} onClick={() => revertFile(convId, path, original)}>
              <Icon name="discard" />
            </button>
          </div>
        ))}
    </div>
  )
}
