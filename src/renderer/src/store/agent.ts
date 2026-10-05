import { create } from 'zustand'
import { AGENT_TOOLS, MUTATING_TOOLS, resolveWorkspacePath, type ToolName } from '@shared/agent'
import { stopReasonNotice, type ModelRef } from '@shared/ai'
import { streamChat, type ChatHandle } from '../lib/ai'
import { executeTool, readCurrent, removeCurrent, writeCurrent } from '../lib/agentTools'
import { relative } from '../lib/paths'
import {
  agentStepMessages,
  newId,
  registerAgentRunner,
  setPendingNote,
  setStreaming,
  toApiMessages,
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

/** Demande d'approbation en attente (affichée dans le chat). */
export const useAgent = create<{ approval: { turnId: string; stepId: string; index: number; command: string } | null }>()(() => ({
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
    const agent = useIde.getState().settings.agent
    if (!agent.allowlist.includes(pending.command)) void updateSettings({ agent: { ...agent, allowlist: [...agent.allowlist, pending.command] } })
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

async function runAgent(convId: string, turnId: string, userTurnId: string, model: ModelRef, turns: Turn[]): Promise<void> {
  const ide = useIde.getState()
  const root = ide.workspace!
  const settings = ide.settings.agent
  const conv = useChat.getState().conversations.find((c) => c.id === convId)!
  const history = toApiMessages(turns)
  const checkpoint: Record<string, string | null> = {}
  const steps: AgentStep[] = []
  const totals = { inputTokens: 0, outputTokens: 0 }
  let status: AssistantTurn['status'] = 'done'
  let error: string | undefined
  const notices: string[] = []
  const current: Run = { stopped: false, handle: null, commandId: null, resolveApproval: null }
  run = current

  updateTurn(convId, turnId, (t) => ({ ...t, steps: [] }))

  try {
    for (let i = 0; i < settings.maxSteps && !current.stopped; i++) {
      const step: AgentStep = { id: newId('s'), text: '', reasoning: '', tools: [] }
      updateTurn(convId, turnId, (t) => ({ ...t, steps: [...(t.steps ?? []), step] }))

      let text = ''
      let reasoning = ''
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
          messages: [...history, ...agentStepMessages(steps)],
          tools: AGENT_TOOLS,
          showReasoning: ide.settings.showReasoning
        },
        (ev) => {
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
          approve: (command) =>
            new Promise<boolean>((resolve) => {
              if (current.stopped) return resolve(false)
              current.resolveApproval = resolve
              useAgent.setState({ approval: { turnId, stepId: step.id, index: idx, command } })
              patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, status: 'approval' }))
            }).then((ok) => {
              patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, status: ok ? 'running' : 'denied' }))
              return ok
            }),
          onCommandOutput: (chunk) => patchTool(convId, turnId, step.id, idx, (r) => ({ ...r, live: ((r.live ?? '') + chunk).slice(-20_000) })),
          setCommandId: (id) => {
            current.commandId = id
          }
        })
        toolRun.output = outcome.output
        toolRun.isError = outcome.isError
        toolRun.summary = outcome.summary
        const denied = toolRun.call.name === 'run_command' && outcome.output.startsWith('L’utilisateur a refusé')
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
      usage: totals
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
