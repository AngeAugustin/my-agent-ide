import { create } from 'zustand'
import type { ChatMessage, ContentPart, ModelRef } from '@shared/ai'
import { agentSystemPrompt } from '@shared/agent'
import { agentStepMessages, type AgentStep } from '../lib/agentHistory'
export { agentStepMessages }
export type { AgentStep, AgentToolRun, ToolRunStatus } from '../lib/agentHistory'
import { streamChat, type ChatHandle } from '../lib/ai'
import { contextKey, resolveContext, type ContextItem } from '../lib/context'
import { getActiveEditor } from '../lib/activeEditor'
import { currentSelection } from '../lib/context'
import { buildUserMessage, chatSystemPrompt, type ResolvedContext } from '../lib/prompts'
import { isInside, relative } from '../lib/paths'
import { useIde } from './ide'
import { stopReasonNotice } from '@shared/ai'

export interface UserTurn {
  id: string
  role: 'user'
  text: string
  contexts: ContextItem[]
  /** Message réellement envoyé (question + contexte), figé pour que l'historique reste identique. */
  sent: string
  images: Array<{ name: string; mediaType: string; data: string }>
  truncated: string[]
  /** Mode Agent : état des fichiers avant les modifications de ce tour (null = fichier inexistant). */
  checkpoint?: { files: Record<string, string | null>; restored?: boolean }
}

export interface AssistantTurn {
  id: string
  role: 'assistant'
  text: string
  reasoning: string
  model: ModelRef
  status: 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  notices: string[]
  providerData?: ChatMessage['providerData']
  usage?: { inputTokens: number; outputTokens: number }
  /** Mode Agent : étapes successives (le texte final est celui de la dernière étape). */
  steps?: AgentStep[]
}

export type Turn = UserTurn | AssistantTurn

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Prompt système figé à la création (un historique stable garde le cache et la réflexion valides). */
  system: string
  model?: ModelRef
  /** « agent » : le modèle dispose d'outils pour lire, modifier et exécuter (fixé à la création). */
  mode?: 'chat' | 'agent'
  /** Note ajoutée au prochain message (ex. fichiers restaurés), pour garder l'historique en ajout seul. */
  pendingNote?: string
  turns: Turn[]
}

interface ChatState {
  visible: boolean
  width: number
  view: 'chat' | 'history'
  conversations: Conversation[]
  activeId: string | null
  /** Contexte en attente dans la zone de saisie. */
  draftContexts: ContextItem[]
  /** Inclure automatiquement le fichier actif. */
  includeActiveFile: boolean
  streamingId: string | null
  focusNonce: number
  loadedFor: string | null | undefined
  /** Mode choisi pour la prochaine nouvelle conversation. */
  mode: 'chat' | 'agent'
}

export const useChat = create<ChatState>()(() => ({
  visible: false,
  width: 420,
  view: 'chat',
  conversations: [],
  activeId: null,
  draftContexts: [],
  includeActiveFile: true,
  streamingId: null,
  focusNonce: 0,
  loadedFor: undefined,
  mode: 'chat'
}))

const set = useChat.setState
const get = useChat.getState
let handle: ChatHandle | null = null
let idCounter = 0

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++idCounter).toString(36)}`

// ---------------------------------------------------------------------------
// Persistance (un fichier par dossier de travail)
// ---------------------------------------------------------------------------

async function loadFor(workspace: string | null): Promise<void> {
  if (get().loadedFor === workspace) return
  handle?.abort()
  const data = (await window.api.chats.load(workspace)) as { conversations?: Conversation[]; activeId?: string | null } | null
  const conversations = (data?.conversations ?? []).map((c) => ({
    ...c,
    // Une réponse interrompue par la fermeture de l'application n'est plus en cours.
    turns: c.turns.map((t) => (t.role === 'assistant' && t.status === 'streaming' ? { ...t, status: 'stopped' as const } : t))
  }))
  set({ conversations, activeId: data?.activeId ?? conversations[0]?.id ?? null, loadedFor: workspace, streamingId: null, draftContexts: [] })
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const { conversations, activeId, loadedFor } = get()
    if (loadedFor === undefined) return
    void window.api.chats.save(loadedFor, { conversations: conversations.slice(0, 100), activeId })
  }, 500)
}

useChat.subscribe((s, prev) => {
  if (s.conversations !== prev.conversations || s.activeId !== prev.activeId) persist()
})

useIde.subscribe((s, prev) => {
  if (s.workspace !== prev.workspace && s.ready) void loadFor(s.workspace)
  if (s.ready && !prev.ready) void loadFor(s.workspace)
})

// ---------------------------------------------------------------------------
// Panneau
// ---------------------------------------------------------------------------

export function toggleChat(visible?: boolean): void {
  const next = visible ?? !get().visible
  set({ visible: next, focusNonce: next ? Date.now() : get().focusNonce })
}

export function focusChat(): void {
  set({ visible: true, view: 'chat', focusNonce: Date.now() })
}

export function setChatWidth(width: number): void {
  set({ width: Math.max(300, Math.min(width, window.innerWidth - 400)) })
}

export function showHistory(show: boolean): void {
  set({ view: show ? 'history' : 'chat' })
}

export function activeConversation(): Conversation | undefined {
  const { conversations, activeId } = get()
  return conversations.find((c) => c.id === activeId)
}

export function newConversation(): void {
  stopStreaming()
  set({ activeId: null, view: 'chat', draftContexts: [], focusNonce: Date.now(), visible: true })
}

export function openConversation(id: string): void {
  set({ activeId: id, view: 'chat', focusNonce: Date.now() })
}

export function deleteConversation(id: string): void {
  if (get().streamingId && activeConversation()?.id === id) stopStreaming()
  set((s) => ({
    conversations: s.conversations.filter((c) => c.id !== id),
    activeId: s.activeId === id ? null : s.activeId
  }))
}

export function setConversationModel(model: ModelRef): void {
  const conv = activeConversation()
  if (conv) updateConversation(conv.id, (c) => ({ ...c, model }))
}

// ---------------------------------------------------------------------------
// Contexte en attente
// ---------------------------------------------------------------------------

export function addContext(item: ContextItem): void {
  const key = contextKey(item)
  set((s) => (s.draftContexts.some((c) => contextKey(c) === key) ? {} : { draftContexts: [...s.draftContexts, item] }))
}

export function removeContext(item: ContextItem): void {
  const key = contextKey(item)
  set((s) => ({ draftContexts: s.draftContexts.filter((c) => contextKey(c) !== key) }))
}

export function setIncludeActiveFile(value: boolean): void {
  set({ includeActiveFile: value })
}

/** Ctrl+L : ouvre le chat et y ajoute la sélection courante, s'il y en a une. */
export function chatWithSelection(toggle: boolean): void {
  const selection = currentSelection(getActiveEditor(), useIde.getState().activeId)
  if (selection) {
    addContext(selection)
    focusChat()
  } else if (toggle) toggleChat()
  else focusChat()
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------

export function updateConversation(id: string, fn: (c: Conversation) => Conversation): void {
  set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)) }))
}

export function updateTurn(convId: string, turnId: string, fn: (t: AssistantTurn) => AssistantTurn): void {
  updateConversation(convId, (c) => ({
    ...c,
    updatedAt: Date.now(),
    turns: c.turns.map((t) => (t.id === turnId && t.role === 'assistant' ? fn(t) : t))
  }))
}

/** Reconstitue l'historique envoyé au modèle (tours terminés uniquement, contenu inchangé). */
export function toApiMessages(turns: Turn[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const t of turns) {
    if (t.role === 'user') {
      const content: ContentPart[] | string = t.images.length
        ? [{ type: 'text', text: t.sent }, ...t.images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data }))]
        : t.sent
      out.push({ role: 'user', content })
    } else if (t.steps) {
      out.push(...agentStepMessages(t.steps))
    } else if (t.text || t.providerData) {
      // Une réponse interrompue n'a pas de contenu natif complet : on n'en garde que le texte.
      out.push({ role: 'assistant', content: t.text, ...(t.status === 'done' && t.providerData ? { providerData: t.providerData } : {}) })
    }
  }
  return out
}

function osName(): string {
  const p = window.api.platform
  return p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p
}

function relPath(path: string): string {
  const ws = useIde.getState().workspace
  return ws && isInside(ws, path) ? relative(ws, path).split('\\').join('/') : path
}

/** Contexte effectivement joint au prochain message (sélection explicite + fichier actif éventuel). */
export function pendingContexts(): ContextItem[] {
  const { draftContexts, includeActiveFile } = get()
  const active = useIde.getState().activeId
  const items = [...draftContexts]
  if (includeActiveFile && active && !active.startsWith('ide://') && !active.startsWith('untitled:')) {
    const already = items.some((c) => (c.kind === 'file' && c.path === active) || (c.kind === 'selection' && c.path === active))
    if (!already) items.unshift({ kind: 'file', path: active })
  }
  return items
}

export async function sendMessage(text: string): Promise<void> {
  const question = text.trim()
  if (!question || get().streamingId) return
  const ide = useIde.getState()

  let conv = activeConversation()
  const mode = conv?.mode ?? get().mode
  const models = ide.settings.ai.models
  const model = conv?.model ?? (mode === 'agent' ? (models.agent ?? models.chat) : models.chat)
  if (!model) {
    throw new Error(
      mode === 'agent'
        ? 'Aucun modèle n’est configuré pour l’agent. Choisissez-en un dans Paramètres › Modèles et clés API.'
        : 'Aucun modèle de chat n’est configuré. Choisissez-en un dans Paramètres › Modèles et clés API.'
    )
  }
  if (mode === 'agent' && !ide.workspace) throw new Error('Ouvrez un dossier pour utiliser l’agent.')
  if (mode === 'agent' && !agentRunner) throw new Error('Le mode Agent n’est pas disponible.')

  if (!conv) {
    conv = {
      id: newId('conv'),
      title: question.replace(/\s+/g, ' ').slice(0, 60),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      system:
        mode === 'agent'
          ? agentSystemPrompt({ os: osName(), workspace: ide.workspace!, date: new Date().toISOString().slice(0, 10) })
          : chatSystemPrompt({ os: osName(), workspace: ide.workspace, activeFile: null }),
      model,
      mode,
      turns: []
    }
    set((s) => ({ conversations: [conv!, ...s.conversations], activeId: conv!.id }))
  }

  const items = pendingContexts()
  const resolved: ResolvedContext[] = []
  const truncated: string[] = []
  const errors: string[] = []
  for (const item of items.filter((i) => i.kind !== 'image')) {
    try {
      const r = await resolveContext(item)
      if (r) {
        resolved.push(r)
        if (r.truncated) truncated.push(r.label)
      }
    } catch (err) {
      errors.push(`${item.kind === 'file' || item.kind === 'folder' ? relPath(item.path) : item.kind} : ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const images = items.filter((i): i is Extract<ContextItem, { kind: 'image' }> => i.kind === 'image')
  const activeFile = ide.activeId && !ide.activeId.startsWith('ide://') ? relPath(ide.activeId) : null
  const header = activeFile ? `(Fichier ouvert dans l’éditeur : ${activeFile})\n\n` : ''

  const userTurn: UserTurn = {
    id: newId('u'),
    role: 'user',
    text: question,
    contexts: items.map((i) => (i.kind === 'image' ? { ...i, data: '' } : i)),
    sent: (conv.pendingNote ? `${conv.pendingNote}\n\n` : '') + header + buildUserMessage(question, resolved),
    images: images.map((i) => ({ name: i.name, mediaType: i.mediaType, data: i.data })),
    truncated
  }
  const assistant: AssistantTurn = {
    id: newId('a'),
    role: 'assistant',
    text: '',
    reasoning: '',
    model,
    status: 'streaming',
    notices: errors.map((e) => `Contexte ignoré — ${e}`)
  }
  const convId = conv.id
  updateConversation(convId, (c) => ({ ...c, updatedAt: Date.now(), pendingNote: undefined, turns: [...c.turns, userTurn, assistant] }))
  set({ draftContexts: [], streamingId: assistant.id })

  const turns = activeConversation()!.turns.filter((t) => t.id !== assistant.id)
  if (mode === 'agent') await agentRunner!(convId, assistant.id, userTurn.id, model, turns)
  else await runAssistant(convId, assistant.id, model, turns)
}

// ---------------------------------------------------------------------------
// Mode Agent (le moteur est enregistré par store/agent.ts)
// ---------------------------------------------------------------------------

type AgentRunner = (convId: string, assistantId: string, userTurnId: string, model: ModelRef, turns: Turn[]) => Promise<void>
let agentRunner: AgentRunner | null = null
let agentStopper: (() => void) | null = null

export function registerAgentRunner(run: AgentRunner, stop: () => void): void {
  agentRunner = run
  agentStopper = stop
}

export function setMode(mode: 'chat' | 'agent'): void {
  set({ mode })
}

export function setStreaming(id: string | null): void {
  set({ streamingId: id })
}

export function updateUserTurn(convId: string, turnId: string, fn: (t: UserTurn) => UserTurn): void {
  updateConversation(convId, (c) => ({ ...c, turns: c.turns.map((t) => (t.id === turnId && t.role === 'user' ? fn(t) : t)) }))
}

export function setPendingNote(convId: string, note: string): void {
  updateConversation(convId, (c) => ({ ...c, pendingNote: c.pendingNote ? `${c.pendingNote}\n${note}` : note }))
}

async function runAssistant(convId: string, turnId: string, model: ModelRef, turns: Turn[]): Promise<void> {
  const conv = get().conversations.find((c) => c.id === convId)!
  let pendingText = ''
  let pendingReasoning = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    flushTimer = null
    if (!pendingText && !pendingReasoning) return
    const t = pendingText
    const r = pendingReasoning
    pendingText = ''
    pendingReasoning = ''
    updateTurn(convId, turnId, (turn) => ({ ...turn, text: turn.text + t, reasoning: turn.reasoning + r }))
  }

  handle = streamChat(
    {
      providerId: model.providerId,
      model: model.modelId,
      system: conv.system,
      messages: toApiMessages(turns),
      showReasoning: useIde.getState().settings.showReasoning
    },
    (ev) => {
      if (ev.type === 'text') pendingText += ev.text
      else if (ev.type === 'reasoning') pendingReasoning += ev.text
      else if (ev.type === 'notice') updateTurn(convId, turnId, (t) => ({ ...t, notices: [...t.notices, ev.message] }))
      if ((ev.type === 'text' || ev.type === 'reasoning') && !flushTimer) flushTimer = setTimeout(flush, 40)
    }
  )
  const result = await handle.result
  if (flushTimer) clearTimeout(flushTimer)
  flush()
  handle = null

  updateTurn(convId, turnId, (t) => {
    if (result.ok) {
      const notice = stopReasonNotice(result.stopReason)
      return {
        ...t,
        status: 'done',
        providerData: result.message.providerData,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        notices: notice ? [...t.notices, notice] : t.notices
      }
    }
    if (result.code === 'aborted') return { ...t, status: 'stopped' }
    return { ...t, status: 'error', error: result.message }
  })
  set({ streamingId: null })
}

export function stopStreaming(): void {
  handle?.abort()
  agentStopper?.()
}

/** Relance la dernière réponse (après une erreur ou pour obtenir une autre réponse). */
export async function retryLast(): Promise<void> {
  const conv = activeConversation()
  if (!conv || get().streamingId) return
  const lastAssistant = [...conv.turns].reverse().find((t) => t.role === 'assistant') as AssistantTurn | undefined
  if (!lastAssistant) return
  const model = conv.model ?? useIde.getState().settings.ai.models.chat
  if (!model) return
  // En mode Agent, les actions déjà effectuées restent dans l'historique : on demande de reprendre.
  if (conv.mode === 'agent') return sendMessage('Reprends la tâche là où tu t’es arrêté.')
  const turns = conv.turns.filter((t) => t.id !== lastAssistant.id)
  const fresh: AssistantTurn = { id: newId('a'), role: 'assistant', text: '', reasoning: '', model, status: 'streaming', notices: [] }
  updateConversation(conv.id, (c) => ({ ...c, turns: [...turns, fresh] }))
  set({ streamingId: fresh.id })
  await runAssistant(conv.id, fresh.id, model, turns)
}

export function conversationTitle(c: Conversation): string {
  return c.title || 'Nouvelle conversation'
}

