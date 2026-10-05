import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { ModelRef } from '@shared/ai'
import {
  addContext,
  compactActive,
  contextUsage,
  conversationTitle,
  deleteConversation,
  newConversation,
  openConversation,
  pendingContexts,
  removeContext,
  retryLast,
  sendMessage,
  setChatWidth,
  setConversationModel,
  setIncludeActiveFile,
  setMode,
  showHistory,
  stopStreaming,
  toggleChat,
  useChat,
  type AssistantTurn,
  type Conversation,
  type UserTurn
} from '../store/chat'
import { getFileIndex, openSettings, updateSettings, useIde } from '../store/ide'
import { modelLabel, readyProviders, useAi } from '../store/ai'
import { contextIcon, contextKey, contextLabel, type ContextItem } from '../lib/context'
import { fuzzyFilter } from '../lib/fuzzy'
import { basename, dirname, isInside, relative } from '../lib/paths'
import { formatTokens } from '../lib/ai'
import { Markdown } from './Markdown'
import { AgentAssistantTurn, ChangedFiles } from './AgentTurn'
import { Icon } from './Icon'
import { useWeb } from '../store/web'

// ---------------------------------------------------------------------------
// Mentions « @ »
// ---------------------------------------------------------------------------

interface MentionOption {
  key: string
  label: string
  detail?: string
  icon: string
  item: ContextItem
}

const SPECIAL: Array<{ words: string; label: string; detail: string; icon: string; item: ContextItem }> = [
  { words: 'codebase projet code recherche semantique index', label: 'Codebase', detail: 'Extraits du projet les plus pertinents pour la question', icon: 'database', item: { kind: 'codebase' } },
  { words: 'problemes erreurs diagnostics problems', label: 'Problèmes', detail: 'Erreurs et avertissements de l’éditeur', icon: 'warning', item: { kind: 'problems' } },
  { words: 'git diff modifications changements', label: 'Modifications Git', detail: 'Diff par rapport au dernier commit', icon: 'git-compare', item: { kind: 'git' } },
  { words: 'terminal sortie console', label: 'Terminal', detail: 'Dernières lignes du terminal actif', icon: 'terminal', item: { kind: 'terminal' } },
  { words: 'web internet recherche google en ligne', label: 'Web', detail: 'Recherche sur Internet avec la question', icon: 'globe', item: { kind: 'web' } }
]

function useMentionOptions(query: string | null): MentionOption[] {
  const workspace = useIde((s) => s.workspace)
  const docs = useWeb((s) => s.docs)
  const [files, setFiles] = useState<string[]>([])
  useEffect(() => {
    if (query !== null && workspace) void getFileIndex().then(setFiles)
  }, [query !== null, workspace])

  return useMemo(() => {
    if (query === null) return []
    const rel = (p: string) => (workspace ? relative(workspace, p).split('\\').join('/') : p)
    // Entrées spéciales : la saisie doit être le début d'un de leurs mots-clés (une recherche floue serait trop large).
    const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const special = SPECIAL.filter((s) => !q || `${s.words} ${s.label.toLowerCase()}`.split(/\s+/).some((w) => w.startsWith(q))).map((s) => ({
      key: s.label,
      label: s.label,
      detail: s.detail,
      icon: s.icon,
      item: s.item
    }))
    const docOpts: MentionOption[] = docs
      .filter((d) => !q || `docs documentation ${d.name.toLowerCase()}`.split(/\s+/).some((w) => w.startsWith(q)))
      .map((d) => ({ key: `doc:${d.id}`, label: d.name, detail: `Documentation · ${d.pages} page(s)`, icon: 'book', item: { kind: 'docs', id: d.id, name: d.name } }))
    const urlOpts: MentionOption[] = /^https?:\/\/\S+\.\S+/.test(query)
      ? [{ key: `url:${query}`, label: query.replace(/^https?:\/\//, ''), detail: 'Page web', icon: 'link', item: { kind: 'url', url: query } }]
      : []
    if (urlOpts.length) return urlOpts
    const folders = new Set<string>()
    for (const f of files) {
      let d = dirname(f)
      while (workspace && d !== workspace && isInside(workspace, d) && !folders.has(d)) {
        folders.add(d)
        d = dirname(d)
      }
    }
    const fileOpts: MentionOption[] = (query ? fuzzyFilter(query, files, rel, 30).map((r) => r.item) : files.slice(0, 30)).map((f) => ({
      key: `f:${f}`,
      label: basename(f),
      detail: rel(dirname(f)) || '.',
      icon: 'file',
      item: { kind: 'file', path: f }
    }))
    const folderOpts: MentionOption[] = (query ? fuzzyFilter(query, [...folders], rel, 8).map((r) => r.item) : [...folders].slice(0, 5)).map((d) => ({
      key: `d:${d}`,
      label: `${basename(d)}/`,
      detail: rel(d),
      icon: 'folder',
      item: { kind: 'folder', path: d }
    }))
    return [...special, ...docOpts, ...fileOpts, ...folderOpts].slice(0, 40)
  }, [query, files, workspace, docs])
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function ContextChip({ item, onRemove, dim, onClick, title }: { item: ContextItem; onRemove?: () => void; dim?: boolean; onClick?: () => void; title?: string }) {
  return (
    <span className={`context-chip${dim ? ' dim' : ''}`} title={title ?? (item.kind === 'file' || item.kind === 'folder' || item.kind === 'selection' ? item.path : item.kind === 'url' ? item.url : contextLabel(item))} onClick={onClick}>
      <Icon name={contextIcon(item)} />
      <span className="context-chip-label">{contextLabel(item)}</span>
      {onRemove && (
        <button className="context-chip-remove" title="Retirer" onClick={(e) => { e.stopPropagation(); onRemove() }}>
          <Icon name="close" />
        </button>
      )}
    </span>
  )
}

function UserMessage({ turn }: { turn: UserTurn }) {
  return (
    <div className="chat-message user">
      {turn.contexts.length > 0 && (
        <div className="chip-row">
          {turn.contexts.map((c) => (
            <ContextChip key={contextKey(c)} item={c} />
          ))}
        </div>
      )}
      <div className="user-text">{turn.text}</div>
      {turn.truncated.length > 0 && <div className="chat-notice">Contenu tronqué (trop volumineux) : {turn.truncated.join(', ')}</div>}
    </div>
  )
}

function AssistantMessage({ turn, last }: { turn: AssistantTurn; last: boolean }) {
  const [showReasoning, setShowReasoning] = useState(false)
  const streaming = turn.status === 'streaming'
  useAi((s) => s.providers)

  return (
    <div className="chat-message assistant">
      {turn.reasoning && (
        <div className="reasoning">
          <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
            <Icon name={showReasoning ? 'chevron-down' : 'chevron-right'} />
            {streaming && !turn.text ? 'Réflexion en cours…' : 'Réflexion'}
          </button>
          {showReasoning && <div className="reasoning-text">{turn.reasoning}</div>}
        </div>
      )}
      {turn.text ? <Markdown text={turn.text} streaming={streaming} /> : streaming && !turn.reasoning ? <div className="typing"><span /><span /><span /></div> : null}
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
              Réessayer
            </button>
          )}
        </div>
      )}
      {turn.status === 'stopped' && <div className="chat-notice">Réponse interrompue.</div>}
      {!streaming && (
        <div className="message-footer">
          <span className="muted small">
            {modelLabel(turn.model)}
            {turn.usage ? ` · ${formatTokens(turn.usage.inputTokens)} → ${formatTokens(turn.usage.outputTokens)} jetons` : ''}
          </span>
          <div className="message-actions">
            {turn.text && (
              <button className="icon-button" title="Copier la réponse" onClick={() => navigator.clipboard.writeText(turn.text)}>
                <Icon name="copy" />
              </button>
            )}
            {last && turn.status !== 'error' && (
              <button className="icon-button" title="Régénérer" onClick={() => retryLast()}>
                <Icon name="refresh" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  const mode = useChat((s) => s.mode)
  const hasModel = useIde((s) => !!(mode === 'agent' ? s.settings.ai.models.agent ?? s.settings.ai.models.chat : s.settings.ai.models.chat))
  return (
    <div className="chat-empty">
      <Icon name={mode === 'agent' ? 'hubot' : 'sparkle'} />
      {mode === 'agent' ? (
        <>
          <h3>Confiez une tâche à l’agent</h3>
          <p className="muted">
            L’agent explore le projet, modifie les fichiers et lance des commandes (avec votre accord) jusqu’à terminer la tâche. Chaque demande crée un
            point de restauration pour tout annuler.
          </p>
        </>
      ) : (
        <>
          <h3>Posez une question sur votre code</h3>
          <p className="muted">
            Tapez <kbd>@</kbd> pour joindre des fichiers, des dossiers, les problèmes, le diff Git, le terminal, le web, une documentation ou une adresse (<code>@https://…</code>). Sélectionnez du code puis{' '}
            <kbd>Ctrl+L</kbd> pour l’ajouter à la conversation.
          </p>
        </>
      )}
      {!hasModel && (
        <button className="btn primary" onClick={() => openSettings('ai')}>
          Configurer un modèle
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Saisie
// ---------------------------------------------------------------------------

function ModelSelect({ conv }: { conv?: Conversation }) {
  const mode = conv?.mode ?? useChat.getState().mode
  const role = mode === 'agent' ? 'agent' : 'chat'
  useChat((s) => s.mode)
  const fallback = useIde((s) => (role === 'agent' ? s.settings.ai.models.agent ?? s.settings.ai.models.chat : s.settings.ai.models.chat))
  useAi((s) => s.providers)
  const current = conv?.model ?? fallback
  const providers = readyProviders()
  const value = current ? `${current.providerId}::${current.modelId}` : ''
  const known = providers.some((p) => p.id === current?.providerId && p.models.some((m) => m.id === current?.modelId))
  return (
    <select
      className="chat-model-select"
      value={value}
      title="Modèle utilisé pour cette conversation"
      onChange={(e) => {
        const [providerId, ...rest] = e.target.value.split('::')
        const ref: ModelRef = { providerId, modelId: rest.join('::') }
        if (conv) setConversationModel(ref)
        else {
          const ai = useIde.getState().settings.ai
          void updateSettings({ ai: { ...ai, models: { ...ai.models, [role]: ref } } })
        }
      }}
    >
      {!current && <option value="">Aucun modèle</option>}
      {current && !known && <option value={value}>{current.modelId}</option>}
      {providers.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.models.map((m) => (
            <option key={m.id} value={`${p.id}::${m.id}`}>
              {m.name ?? m.id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function ChatInput({ conv }: { conv?: Conversation }) {
  const [text, setText] = useState('')
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const streaming = useChat((s) => !!s.streamingId)
  const mode = useChat((s) => s.mode)
  const focusNonce = useChat((s) => s.focusNonce)
  const draft = useChat((s) => s.draftContexts)
  const includeActive = useChat((s) => s.includeActiveFile)
  const activeId = useIde((s) => s.activeId)
  const options = useMentionOptions(mention?.query ?? null)

  useEffect(() => {
    ref.current?.focus()
  }, [focusNonce])

  useEffect(() => setSelected(0), [mention?.query])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const activeFile = activeId && !activeId.startsWith('ide://') && !activeId.startsWith('untitled:') ? activeId : null
  const activeExplicit = draft.some((c) => (c.kind === 'file' || c.kind === 'selection') && c.path === activeFile)

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const m = before.match(/(^|\s)@([^\s@]*)$/)
    setMention(m ? { start: caret - m[2].length - 1, query: m[2] } : null)
  }

  const pick = (opt: MentionOption | undefined) => {
    if (!opt || !mention) return
    const el = ref.current!
    const caret = el.selectionStart
    const next = text.slice(0, mention.start) + text.slice(caret)
    setText(next)
    setMention(null)
    addContext(opt.item)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(mention.start, mention.start)
    })
  }

  const submit = async () => {
    if (!text.trim() || streaming) return
    setError(null)
    const value = text
    setText('')
    try {
      await sendMessage(value)
    } catch (err) {
      setText(value)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && options.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => Math.min(i + 1, options.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[selected])
        return
      }
    }
    if (e.key === 'Escape' && mention) {
      e.preventDefault()
      setMention(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        setError(`Image trop volumineuse (${Math.round(file.size / 1024 / 1024)} Mo, maximum 5 Mo).`)
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const data = String(reader.result).split(',')[1] ?? ''
        addContext({ kind: 'image', name: file.name || `image-${Date.now()}.png`, mediaType: file.type, data })
      }
      reader.readAsDataURL(file)
    }
  }

  return (
    <div className="chat-input">
      {mention && options.length > 0 && (
        <div className="mention-popup" role="listbox">
          {options.map((o, i) => (
            <div
              key={o.key}
              role="option"
              aria-selected={i === selected}
              className={`mention-item${i === selected ? ' selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
              onMouseMove={() => setSelected(i)}
            >
              <Icon name={o.icon} />
              <span className="mention-label">{o.label}</span>
              {o.detail && <span className="mention-detail">{o.detail}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="chip-row">
        {activeFile && !activeExplicit && (
          <ContextChip
            item={{ kind: 'file', path: activeFile }}
            dim={!includeActive}
            title={includeActive ? 'Fichier actif joint automatiquement — cliquer pour l’exclure' : 'Cliquer pour joindre le fichier actif'}
            onClick={() => setIncludeActiveFile(!includeActive)}
          />
        )}
        {draft.map((c) => (
          <ContextChip key={contextKey(c)} item={c} onRemove={() => removeContext(c)} />
        ))}
        <button
          className="add-context"
          title="Joindre du contexte (@)"
          onClick={() => {
            const el = ref.current!
            const caret = el.selectionStart ?? text.length
            const needsSpace = caret > 0 && !/\s/.test(text[caret - 1])
            const next = `${text.slice(0, caret)}${needsSpace ? ' ' : ''}@${text.slice(caret)}`
            setText(next)
            const pos = caret + (needsSpace ? 2 : 1)
            requestAnimationFrame(() => {
              el.focus()
              el.setSelectionRange(pos, pos)
              updateMention(next, pos)
            })
          }}
        >
          <Icon name="mention" />
        </button>
      </div>
      <textarea
        ref={ref}
        value={text}
        rows={2}
        placeholder={
          (conv?.mode ?? mode) === 'agent'
            ? 'Décrivez la tâche à réaliser (ex. « ajoute des tests pour utils.ts et fais-les passer »)…'
            : 'Posez une question, @ pour joindre du contexte…'
        }
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          updateMention(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onClick={(e) => updateMention(text, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setMention(null), 150)}
      />
      {error && (
        <div className="chat-error small">
          <Icon name="error" /> <span>{error}</span>
        </div>
      )}
      <div className="chat-input-footer">
        {!conv || conv.turns.length === 0 ? (
          <div className="mode-toggle" role="radiogroup" aria-label="Mode">
            <button role="radio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')} title="Questions et réponses">
              <Icon name="comment" /> Chat
            </button>
            <button role="radio" aria-checked={mode === 'agent'} className={mode === 'agent' ? 'active' : ''} onClick={() => setMode('agent')} title="L’agent modifie le projet et lance des commandes">
              <Icon name="hubot" /> Agent
            </button>
          </div>
        ) : (
          <span className="mode-badge" title={conv.mode === 'agent' ? 'Conversation en mode Agent' : 'Conversation en mode Chat'}>
            <Icon name={conv.mode === 'agent' ? 'hubot' : 'comment'} /> {conv.mode === 'agent' ? 'Agent' : 'Chat'}
          </span>
        )}
        <ModelSelect conv={conv} />
        {conv && <ContextGauge conv={conv} disabled={streaming} onError={setError} />}
        <span className="muted small">{pendingContexts().length > 0 ? `${pendingContexts().length} élément(s) joint(s)` : ''}</span>
        {streaming ? (
          <button className="btn send-button" title="Arrêter la génération" onClick={stopStreaming}>
            <Icon name="debug-stop" /> Arrêter
          </button>
        ) : (
          <button className="btn primary send-button" title="Envoyer (Entrée)" disabled={!text.trim()} onClick={submit}>
            <Icon name="send" /> Envoyer
          </button>
        )}
      </div>
    </div>
  )
}

/** Remplissage du contexte du modèle ; un clic résume la conversation. */
function ContextGauge({ conv, disabled, onError }: { conv: Conversation; disabled: boolean; onError: (e: string | null) => void }) {
  const compacting = useChat((s) => s.compactingId === conv.id)
  useAi((s) => s.providers)
  const usage = contextUsage(conv)
  if (!usage || usage.used === 0) return null
  const pct = Math.min(100, Math.round((usage.used / usage.window) * 100))
  return (
    <button
      className={`context-gauge${pct >= 80 ? ' high' : pct >= 50 ? ' mid' : ''}`}
      disabled={disabled || compacting}
      title={`Contexte utilisé : ${formatTokens(usage.used)} / ${formatTokens(usage.window)} jetons. Cliquez pour résumer la conversation et libérer de la place.`}
      onClick={() => {
        onError(null)
        compactActive().catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      }}
    >
      <span className="context-gauge-ring" style={{ ['--pct' as string]: `${pct}%` }} />
      {compacting ? 'Résumé…' : `${pct} %`}
    </button>
  )
}

function SummaryDivider({ conv }: { conv: Conversation }) {
  const [open, setOpen] = useState(false)
  const summary = conv.summary!
  return (
    <div className="summary-divider">
      <button className="link-button" onClick={() => setOpen(!open)} title="Afficher le résumé envoyé au modèle">
        <Icon name={open ? 'chevron-down' : 'chevron-right'} /> Conversation résumée ici ({formatTokens(summary.tokensBefore)} jetons condensés)
      </button>
      {open && (
        <div className="summary-text">
          <Markdown text={summary.text} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panneau
// ---------------------------------------------------------------------------

function History() {
  const conversations = useChat((s) => s.conversations)
  const activeId = useChat((s) => s.activeId)
  return (
    <div className="chat-history">
      {conversations.length === 0 && <p className="muted chat-history-empty">Aucune conversation pour ce dossier.</p>}
      {conversations.map((c) => (
        <div key={c.id} className={`history-item${c.id === activeId ? ' active' : ''}`} onClick={() => openConversation(c.id)}>
          <div className="history-title">{conversationTitle(c)}</div>
          <div className="history-meta muted small">
            {new Date(c.updatedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {c.turns.filter((t) => t.role === 'user').length} message(s)
          </div>
          <button
            className="icon-button history-delete"
            title="Supprimer"
            onClick={(e) => {
              e.stopPropagation()
              deleteConversation(c.id)
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function ChatPanel() {
  const width = useChat((s) => s.width)
  const view = useChat((s) => s.view)
  const conv = useChat((s) => s.conversations.find((c) => c.id === s.activeId))
  const compacting = useChat((s) => !!s.activeId && s.compactingId === s.activeId)
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [conv?.turns])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) => setChatWidth(startW - (ev.clientX - startX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing-col')
    }
    document.body.classList.add('resizing-col')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const turns = conv?.turns ?? []
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')

  return (
    <aside className="chat-panel" style={{ width }}>
      <div className="chat-resizer" onMouseDown={startResize} />
      <div className="chat-header">
        <span className="chat-title" title={conv ? conversationTitle(conv) : undefined}>
          {view === 'history' ? 'Historique' : conv ? conversationTitle(conv) : 'Nouvelle conversation'}
        </span>
        <div className="sidebar-actions">
          <button className="icon-button" title="Nouvelle conversation" onClick={newConversation}>
            <Icon name="add" />
          </button>
          <button className={`icon-button${view === 'history' ? ' active' : ''}`} title="Historique" onClick={() => showHistory(view !== 'history')}>
            <Icon name="history" />
          </button>
          <button className="icon-button" title="Fermer (Ctrl+L)" onClick={() => toggleChat(false)}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      {view === 'history' ? (
        <History />
      ) : (
        <>
          <div
            className="chat-messages"
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {turns.length === 0 && <EmptyState />}
            {turns.map((t, i) => {
              const divider = conv?.summary?.turnId === t.id ? <SummaryDivider key={`sum-${t.id}`} conv={conv} /> : null
              if (t.role === 'user') return <UserMessage key={t.id} turn={t} />
              if (!t.steps)
                return (
                  <div key={t.id}>
                    <AssistantMessage turn={t} last={t === lastAssistant} />
                    {divider}
                  </div>
                )
              const userTurn = turns[i - 1]?.role === 'user' ? (turns[i - 1] as UserTurn) : undefined
              return (
                <div key={t.id} className="agent-turn">
                  <AgentAssistantTurn convId={conv!.id} turn={t} last={t === lastAssistant} />
                  {userTurn && t.status !== 'streaming' && <ChangedFiles convId={conv!.id} turn={userTurn} />}
                  {divider}
                </div>
              )
            })}
            {compacting && (
              <div className="chat-notice compacting">
                <Icon name="loading" className="codicon-modifier-spin" /> Résumé de la conversation pour libérer de la place…
              </div>
            )}
          </div>
          <ChatInput conv={conv} />
        </>
      )}
    </aside>
  )
}

