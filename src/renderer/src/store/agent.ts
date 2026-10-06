import { create } from 'zustand'
import { AGENT_TOOLS, MUTATING_TOOLS, WEB_TOOLS, resolveWorkspacePath, type ToolName } from '@shared/agent'
import { stopReasonNotice, type ModelRef } from '@shared/ai'
import { READ_ONLY_TOOLS, type AssistantMode } from '@shared/modes'
import { formatTokens, streamChat, type ChatHandle } from '../lib/ai'
import { estimateTokens, summaryPreamble } from '@shared/compaction'
import { needsCompaction, summarizeHistory } from '../lib/compaction'
import { executeTool, readCurrent, removeCurrent, writeCurrent } from '../lib/agentTools'
import { relative } from '../lib/paths'
import {
  agentStepMessages,
  newId,
  registerAgentRunner,
  setPendingNote,
  setStreaming,
  toApiMessages,
  updateConversation,
  updateTurn,
  updateUserTurn,
  useChat,
  type AgentStep,
  type AgentToolRun,
  type AssistantTurn,
  type Turn,
  type UserTurn
} from './chat'
import { notify, reportError, updateSettings, useIde } from './ide'
import { mcpTools, setAutoApprove, type McpToolRef } from './mcp'

/** Demande d'approbation en attente (affichée dans le chat). */
export const useAgent = create<{
  approval: { turnId: string; stepId: string; index: number; command: string; mcp?: McpToolRef } | null
}>()(() => ({
  approval: null
}))

interface Run {
  stopped: boolean
  handle: ChatHandle | null
  commandId: string | null
  resolveApproval: ((ok: boolean) => void) | null
}

let run: Run | null = null

export function answerApproval(decision: 'run' | 'deny' | 'always'): void {
  const pending = useAgent.getState().approval
  if (!run?.resolveApproval || !pending) return
  if (decision === 'always') {
    if (pending.mcp) void setAutoApprove(pending.mcp.source, pending.mcp.server, true)
    else {
      const agent = useIde.getState().settings.agent
      if (!agent.allowlist.includes(pending.command)) void updateSettings({ agent: { ...agent, allowlist: [...agent.allowlist, pending.command] } })
    }
  }
  const resolve = run.resolveApproval
  run.resolveApproval = null
  useAgent.setState({ approval: null })
  resolve(decision !== 'deny')
}

function stopAgent(): void {
  if (!run) return
  run.stopped = true
  run.handle?.abort()
  if (run.commandId) window.api.agent.kill(run.commandId)
  if (run.resolveApproval) {
    const r = run.resolveApproval
    run.resolveApproval = null
    useAgent.setState({ approval: null })
    r(false)
  }
}

function patchStep(convId: string, turnId: string, stepId: string, fn: (s: AgentStep) => AgentStep): void {
  updateTurn(convId, turnId, (t) => ({ ...t, steps: (t.steps ?? []).map((s) => (s.id === stepId ? fn(s) : s)) }))
}

function patchTool(convId: string, turnId: string, stepId: string, index: number, fn: (r: AgentToolRun) => AgentToolRun): void {
  patchStep(convId, turnId, stepId, (s) => ({ ...s, tools: s.tools.map((r, i) => (i === index ? fn(r) : r)) }))
}

async function runAgent(convId: string, turnId: string, userTurnId: string, model: ModelRef, turns: Turn[], mode: AssistantMode = 'agent'): Promise<void> {
  const ide = useIde.getState()
  const root = ide.workspace!
  const settings = ide.settings.agent
  const conv = useChat.getState().conversations.find((c) => c.id === convId)!
  let history = toApiMessages(turns, conv.summary)
  // Étapes déjà résumées pendant cette demande (elles ne sont plus envoyées).
  let stepBase = 0
  let lastInput = 0
  const checkpoint: Record<string, string | null> = {}
  const steps: AgentStep[] = []
  const totals = { inputTokens: 0, outputTokens: 0 }
  let status: AssistantTurn['status'] = 'done'
  let error: string | undefined
  const notices: string[] = []
  const current: Run = { stopped: false, handle: null, commandId: null, resolveApproval: null }
  run = current

  updateTurn(convId, turnId, (t) => ({ ...t, steps: [] }))
  // Outils MCP des serveurs connectés au début de la demande.
  const mcp = mcpTools()
  const hasDocs = (await window.api.docs.list().catch(() => [])).some((d) => d.chunks > 0)
  const webTools = ide.settings.web.agentTools ? WEB_TOOLS.filter((t) => t.name !== 'docs_search' || hasDocs) : []
  // Mode Plan : lecture et recherche uniquement (ni modification, ni commande, ni outil MCP).
  const readOnly = mode === 'plan'
  const toolDefinitions = readOnly
    ? [...AGENT_TOOLS, ...webTools].filter((t) => READ_ONLY_TOOLS.includes(t.name))
    : [...AGENT_TOOLS, ...webTools, ...mcp.definitions]

  try {
    for (let i = 0; i < settings.maxSteps && !current.stopped; i++) {
      const step: AgentStep = { id: newId('s'), text: '', reasoning: '', tools: [] }
      updateTurn(convId, turnId, (t) => ({ ...t, steps: [...(t.steps ?? []), step] }))

      let messages = [...history, ...agentStepMessages(steps.slice(stepBase))]
      if (steps.length > stepBase && needsCompaction(model, messages, conv.system, lastInput)) {
        // Contexte presque plein : on résume la conversation et les étapes déjà faites, puis on continue.
        useChat.setState({ compactingId: convId })
        const summary = await summarizeHistory(model, messages, (h) => {
          current.handle = h
        })
        useChat.setState({ compactingId: null })
        if (!summary.ok && summary.aborted) {
          status = 'stopped'
          updateTurn(convId, turnId, (t) => ({ ...t, steps: (t.steps ?? []).filter((s) => s.id !== step.id) }))
          break
        }
        if (summary.ok) {
          const tokensBefore = Math.max(lastInput, estimateTokens(messages, conv.system))
          stepBase = steps.length
          lastInput = 0
          history = [{ role: 'user', content: `${summaryPreamble(summary.text)}\n\nPoursuis la tâche en cours à partir de ce résumé.` }]
          messages = history
          updateConversation(convId, (c) => ({ ...c, summary: { text: summary.text, turnId, stepCount: stepBase, createdAt: Date.now(), tokensBefore } }))
          notices.push(`Contexte résumé en cours de tâche (environ ${formatTokens(tokensBefore)} jetons condensés).`)
        } else notices.push(`Le contexte approche de la limite du modèle et n’a pas pu être résumé : ${summary.message}`)
      }

      let text = ''
      let reasoning = ''
      const requestStart = performance.now()
      let firstSeen = i > 0
      let timer: ReturnType<typeof setTimeout> | null = null
      const flush = () => {
        timer = null
        const tx = text
        const rs = reasoning
        patchStep(convId, turnId, step.id, (s) => ({ ...s, text: tx, reasoning: rs }))
      }

      current.handle = streamChat(
        {
          providerId: model.providerId,
          model: model.modelId,
          system: conv.system,
          messages,
          tools: toolDefinitions,
          showReasoning: ide.settings.showReasoning
        },
        (ev) => {
          if (!firstSeen && (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool_call')) {
            firstSeen = true
            const ttftMs = Math.round(performance.now() - requestStart)
            updateTurn(convId, turnId, (t) => ({ ...t, ttftMs }))
          }
          if (ev.type === 'text') text += ev.text
          else if (ev.type === 'reasoning') reasoning += ev.text
          else if (ev.type === 'notice') notices.push(ev.message)
          if ((ev.type === 'text' || ev.type === 'reasoning') && !timer) timer = setTimeout(flush, 40)
        }
      )
      const result = await current.handle.result
      current.handle = null
      if (timer) clearTimeout(timer)

      if (!result.ok) {
        patchStep(convId, turnId, step.id, (s) => ({ ...s, text, reasoning }))
        // L'étape interrompue n'a pas de contenu natif complet : seul son texte est conservé.
        steps.push({ ...step, text, reasoning })
        if (result.code === 'aborted') status = 'stopped'
        else {
          status = 'error'
          error = result.message
        }
        break
      }

      lastInput = result.inputTokens
      totals.inputTokens += result.inputTokens
      totals.outputTokens += result.outputTokens
      const tools: AgentToolRun[] = result.toolCalls.map((call) => ({ call, status: 'pending' }))
      const done: AgentStep = { ...step, text, reasoning, tools, providerData: result.message.providerData }
      patchStep(convId, turnId, step.id, () => done)
      steps.push(done)

      const notice = stopReasonNotice(result.stopReason)
      if (result.stopReason === 'refusal') {
        if (notice) notices.push(notice)
        // Une réponse refusée peut contenir un appel d'outil incomplet : on ne l'exécute pas.
        tools.forEach((t, idx) => {
          t.status = 'skipped'
          t.output = 'Non exécuté : la réponse a été interrompue.'
          t.isError = true
          patchTool(convId, turnId, step.id, idx, () => ({ ...t }))
        })
        break
      }
      if (tools.length === 0) {
        if (notice) notices.push(notice)
        break
      }

      for (let idx = 0; idx < tools.length; idx++) {
        const toolRun = tools[idx]
        if (current.stopped) break
        if (result.stopReason === 'max_tokens') {
          // Arguments probablement tronqués : on demande au modèle de recommencer.
          toolRun.status = 'error'
          toolRun.output = 'Appel non exécuté : la réponse a atteint la limite de longueur et les arguments sont peut-être incomplets. Recommence en plusieurs étapes plus courtes.'
          toolRun.isError = true
          patchTool(convId, turnId, step.id, idx, () => ({ ...toolRun }))
          continue
        }
        patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, status: 'running' }))
        const outcome = await executeTool(toolRun.call, {
          root,
          settings: useIde.getState().settings.agent,
          snapshot: (path, original) => {
            if (!(path in checkpoint)) checkpoint[path] = original
            updateUserTurn(convId, userTurnId, (u) => ({ ...u, checkpoint: { files: { ...checkpoint } } }))
          },
          mcp: readOnly ? undefined : mcp.refs,
          readOnly,
          approve: (command, mcpRef) =>
            new Promise<boolean>((resolve) => {
              if (current.stopped) return resolve(false)
              current.resolveApproval = resolve
              useAgent.setState({ approval: { turnId, stepId: step.id, index: idx, command, mcp: mcpRef } })
              patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, status: 'approval' }))
            }).then((ok) => {
              patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, status: ok ? 'running' : 'denied' }))
              return ok
            }),
          onCommandOutput: (chunk) => patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, live: ((r.live ?? '') + chunk).slice(-20_000) })),
          setCommandId: (id) => {
            current.commandId = id
          },
          setTodos: (todos) => updateTurn(convId, turnId, (t) => ({ ...t, todos }))
        })
        toolRun.output = outcome.output
        toolRun.isError = outcome.isError
        toolRun.summary = outcome.summary
        const denied = outcome.output.startsWith('L’utilisateur a refusé')
        toolRun.status = denied ? 'denied' : outcome.isError ? 'error' : 'done'
        patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, ...toolRun, live: r.live }))
      }

      if (i === settings.maxSteps - 1 && !current.stopped) {
        notices.push(`Limite de ${settings.maxSteps} étapes atteinte. Demandez à l’agent de continuer si nécessaire.`)
      }
    }
    if (current.stopped && status === 'done') status = 'stopped'
  } catch (err) {
    status = 'error'
    error = err instanceof Error ? err.message : String(err)
  } finally {
    if (run === current) run = null
    useAgent.setState({ approval: null })
    updateTurn(convId, turnId, (t) => ({
      ...t,
      status,
      error,
      notices: [...t.notices, ...notices],
      text: (t.steps ?? []).map((s) => s.text).filter(Boolean).join('\n\n'),
      usage: totals,
      contextTokens: lastInput
    }))
    if (Object.keys(checkpoint).length) updateUserTurn(convId, userTurnId, (u) => ({ ...u, checkpoint: { files: { ...checkpoint } } }))
    setStreaming(null)
  }
}

registerAgentRunner(runAgent, stopAgent)

// ---------------------------------------------------------------------------
// Points de restauration
// ---------------------------------------------------------------------------

async function restoreFile(path: string, original: string | null): Promise<void> {
  const exists = await window.api.fs.exists(path)
  if (original === null) {
    if (exists) await removeCurrent(path)
  } else {
    if (exists && (await readCurrent(path)) === original) return
    await writeCurrent(path, original)
  }
}

/** Fichiers modifiés par l'agent pendant un tour, avec leur état d'origine. */
export function changedFiles(turn: UserTurn): Array<{ path: string; original: string | null }> {
  return Object.entries(turn.checkpoint?.files ?? {}).map(([path, original]) => ({ path, original }))
}

/**
 * Restaure les fichiers tels qu'ils étaient avant ce tour (et annule aussi les tours suivants).
 * L'agent en est informé au prochain message, sans réécrire l'historique.
 */
export async function restoreCheckpoint(convId: string, userTurnId: string): Promise<void> {
  if (useChat.getState().streamingId) return notify('Attendez la fin de l’agent (ou arrêtez-le) avant de restaurer.', 'info')
  const conv = useChat.getState().conversations.find((c) => c.id === convId)
  if (!conv) return
  const start = conv.turns.findIndex((t) => t.id === userTurnId)
  const later = conv.turns.slice(start).filter((t): t is UserTurn => t.role === 'user' && !!t.checkpoint && !t.checkpoint.restored)
  const root = useIde.getState().workspace ?? ''
  const restored = new Set<string>()
  try {
    // Du plus récent au plus ancien : chaque fichier revient à son état d'avant le tour choisi.
    for (const turn of [...later].reverse()) {
      for (const { path, original } of changedFiles(turn)) {
        await restoreFile(path, original)
        restored.add(relative(root, path).split('\\').join('/'))
      }
      updateUserTurn(convId, turn.id, (u) => ({ ...u, checkpoint: u.checkpoint ? { ...u.checkpoint, restored: true } : u.checkpoint }))
    }
  } catch (err) {
    reportError('Restauration incomplète', err)
  }
  if (restored.size) {
    setPendingNote(convId, `(Note : l’utilisateur a restauré ces fichiers à leur état d’avant ta modification : ${[...restored].join(', ')}.)`)
    notify(`${restored.size} fichier(s) restauré(s).`, 'success')
  } else notify('Aucun fichier à restaurer.', 'info')
}

/** Annule la modification d'un seul fichier (retour à l'état d'avant le tour). */
export async function revertFile(convId: string, path: string, original: string | null): Promise<void> {
  try {
    await restoreFile(path, original)
    const root = useIde.getState().workspace ?? ''
    setPendingNote(convId, `(Note : l’utilisateur a annulé ta modification de ${relative(root, path).split('\\').join('/')}.)`)
    notify('Modification annulée.', 'success')
  } catch (err) {
    reportError('Annulation impossible', err)
  }
}

/** Chemin absolu d'un fichier touché par un outil (pour ouvrir le diff). */
export function toolPath(name: ToolName | string, input: unknown): string | null {
  if (!MUTATING_TOOLS.includes(name as ToolName)) return null
  const root = useIde.getState().workspace
  const p = (input as { path?: unknown })?.path
  if (!root || typeof p !== 'string') return null
  const r = resolveWorkspacePath(root, p)
  return 'path' in r ? r.path : null
}
