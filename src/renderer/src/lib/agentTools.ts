import {
  applyEdit,
  isCommandAllowed,
  resolveWorkspacePath,
  truncateOutput,
  validateToolInput,
  type AgentSettings,
  type ToolName
} from '@shared/agent'
import type { ToolCall } from '@shared/ai'
import * as models from './editorModels'
import { monaco } from './monaco'
import { diffLines, diffStats } from './diff'
import { basename, relative } from './paths'
import { closeTab, getFileIndex, useIde } from '../store/ide'
import type { ToolSummary } from './agentHistory'
import type { McpToolRef } from '../store/mcp'
export type { ToolSummary }

export interface ToolOutcome {
  output: string
  isError: boolean
  summary?: ToolSummary
}

export interface ToolContext {
  root: string
  settings: AgentSettings
  /** Mémorise l'état d'origine d'un fichier avant sa première modification (point de restauration). */
  snapshot(path: string, original: string | null): void
  /** Demande l'accord de l'utilisateur pour une commande ou un outil MCP. */
  approve(command: string, mcp?: McpToolRef): Promise<boolean>
  /** Outils MCP disponibles pour cette exécution (nom exposé → serveur et outil). */
  mcp?: Map<string, McpToolRef>
  /** Sortie d'une commande en cours (affichage en direct). */
  onCommandOutput(chunk: string): void
  /** Identifiant de la commande en cours (pour l'arrêter). */
  setCommandId(id: string | null): void
}

const MAX_READ_LINES = 2000
const MAX_LIST = 500

async function exists(path: string): Promise<boolean> {
  return !!models.getEntry(path) || (await window.api.fs.exists(path))
}

/** Contenu actuel d'un fichier : celui de l'éditeur s'il est ouvert (modifications non enregistrées comprises). */
export async function readCurrent(path: string): Promise<string> {
  const entry = models.getEntry(path)
  return entry ? entry.model.getValue() : window.api.fs.readFile(path)
}

/** Écrit sur le disque et met à jour l'éditeur si le fichier y est ouvert (modification annulable). */
export async function writeCurrent(path: string, content: string): Promise<void> {
  const entry = models.getEntry(path)
  if (entry && entry.model.getValue() !== content) {
    entry.model.pushStackElement()
    entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null)
    entry.model.pushStackElement()
  }
  await window.api.fs.writeFile(path, content)
  if (entry) models.markSaved(path)
}

export async function removeCurrent(path: string): Promise<void> {
  if (useIde.getState().tabs.some((t) => t.id === path)) await closeTab(path, true)
  await window.api.fs.trash(path)
}

function rel(root: string, path: string): string {
  return relative(root, path).split('\\').join('/') || '.'
}

function stats(before: string, after: string): { added: number; removed: number } {
  return diffStats(diffLines(before === '' ? [] : before.split('\n'), after === '' ? [] : after.split('\n')))
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(pattern.includes('/') ? `^${source}$` : `(^|/)${source}$`, 'i')
}

async function snapshotIfNeeded(ctx: ToolContext, path: string): Promise<string | null> {
  const original = (await exists(path)) ? await readCurrent(path) : null
  ctx.snapshot(path, original)
  return original
}

/** Exécute un appel d'outil de l'agent. Ne lève jamais : les erreurs sont renvoyées au modèle. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  if (call.inputError !== undefined) {
    return { output: JSON.stringify({ INVALID_JSON: call.inputError.slice(0, 2000) }), isError: true }
  }
  const mcp = ctx.mcp?.get(call.name)
  if (mcp) return executeMcpTool(call, mcp, ctx)
  const invalid = validateToolInput(call.name, call.input)
  if (invalid) return { output: invalid, isError: true }
  const input = call.input as Record<string, unknown>

  const resolve = (p: unknown) => resolveWorkspacePath(ctx.root, String(p))

  try {
    switch (call.name as ToolName) {
      case 'list_dir': {
        const r = resolve(input.path)
        if ('error' in r) return { output: r.error, isError: true }
        const excluded = new Set(useIde.getState().settings.excludedFolders)
        const out: string[] = []
        const walk = async (dir: string, depth: number) => {
          for (const e of await window.api.fs.readDir(dir)) {
            if (out.length >= MAX_LIST) return
            if (e.isDirectory && excluded.has(e.name)) {
              out.push(`${rel(ctx.root, e.path)}/ (ignoré)`)
              continue
            }
            out.push(e.isDirectory ? `${rel(ctx.root, e.path)}/` : rel(ctx.root, e.path))
            if (e.isDirectory && input.recursive && depth < 8) await walk(e.path, depth + 1)
          }
        }
        await walk(r.path, 0)
        const note = out.length >= MAX_LIST ? `\n[liste limitée à ${MAX_LIST} entrées]` : ''
        return { output: (out.join('\n') || '(dossier vide)') + note, isError: false, summary: { path: rel(ctx.root, r.path) } }
      }

      case 'read_file': {
        const r = resolve(input.path)
        if ('error' in r) return { output: r.error, isError: true }
        if (!(await exists(r.path))) return { output: `Fichier introuvable : ${input.path}`, isError: true }
        const content = await readCurrent(r.path)
        if (content.slice(0, 8000).includes('\u0000')) return { output: 'Fichier binaire : contenu non lisible.', isError: true }
        const lines = content.split('\n')
        const start = Math.max(1, Number(input.start_line ?? 1))
        const end = Math.min(lines.length, Number(input.end_line ?? start + MAX_READ_LINES - 1), start + MAX_READ_LINES - 1)
        const width = String(end).length
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(width)}| ${l}`)
          .join('\n')
        const note = end < lines.length ? `\n[lignes ${start}-${end} sur ${lines.length} : utilise start_line pour lire la suite]` : ''
        return { output: truncateOutput(body + note), isError: false, summary: { path: rel(ctx.root, r.path) } }
      }

      case 'search_text': {
        const res = await window.api.search.text(ctx.root, String(input.query), {
          caseSensitive: !!input.case_sensitive,
          wholeWord: false,
          regex: !!input.regex,
          include: typeof input.include === 'string' ? input.include : ''
        })
        const lines: string[] = []
        for (const f of res.files) {
          for (const m of f.matches) {
            if (lines.length >= 200) break
            lines.push(`${rel(ctx.root, f.path)}:${m.line}: ${m.preview.trim()}`)
          }
        }
        const more = res.totalMatches > lines.length ? `\n[${res.totalMatches - lines.length} autres résultats non affichés]` : ''
        return { output: lines.length ? lines.join('\n') + more : 'Aucun résultat.', isError: false }
      }

      case 'codebase_search': {
        const limit = Math.min(Math.max(Number(input.limit ?? 8), 1), 20)
        const hits = await window.api.index.search(String(input.query), limit)
        if (hits.length === 0) return { output: 'Aucun extrait pertinent trouvé (l’index est peut-être en cours de construction).', isError: false }
        const body = hits.map((h) => `--- ${h.path} (lignes ${h.startLine}-${h.endLine})\n${h.text}`).join('\n\n')
        return { output: truncateOutput(body), isError: false }
      }

      case 'find_files': {
        const pattern = String(input.pattern).trim()
        const files = (await getFileIndex()).map((f) => rel(ctx.root, f))
        const matches = pattern.includes('*')
          ? files.filter((f) => globToRegExp(pattern).test(f))
          : files.filter((f) => f.toLowerCase().includes(pattern.toLowerCase()))
        const shown = matches.slice(0, 200)
        return {
          output: shown.length ? shown.join('\n') + (matches.length > 200 ? `\n[${matches.length - 200} autres]` : '') : 'Aucun fichier trouvé.',
          isError: false
        }
      }

      case 'edit_file': {
        const r = resolve(input.path)
        if ('error' in r) return { output: r.error, isError: true }
        if (!(await exists(r.path))) return { output: `Fichier introuvable : ${input.path}. Utilise write_file pour le créer.`, isError: true }
        const before = await readCurrent(r.path)
        const result = applyEdit(before, String(input.old_string), String(input.new_string), !!input.replace_all)
        if ('error' in result) return { output: result.error, isError: true }
        await snapshotIfNeeded(ctx, r.path)
        await writeCurrent(r.path, result.content)
        const s = stats(before, result.content)
        return {
          output: `Fichier modifié : ${rel(ctx.root, r.path)} (${result.count} remplacement(s)).`,
          isError: false,
          summary: { path: rel(ctx.root, r.path), ...s }
        }
      }

      case 'write_file': {
        const r = resolve(input.path)
        if ('error' in r) return { output: r.error, isError: true }
        const original = await snapshotIfNeeded(ctx, r.path)
        const content = String(input.content)
        await writeCurrent(r.path, content)
        const s = stats(original ?? '', content)
        return {
          output: `${original === null ? 'Fichier créé' : 'Fichier réécrit'} : ${rel(ctx.root, r.path)}.`,
          isError: false,
          summary: { path: rel(ctx.root, r.path), ...s }
        }
      }

      case 'delete_file': {
        const r = resolve(input.path)
        if ('error' in r) return { output: r.error, isError: true }
        if (!(await exists(r.path))) return { output: `Fichier introuvable : ${input.path}`, isError: true }
        const original = await snapshotIfNeeded(ctx, r.path)
        await removeCurrent(r.path)
        return {
          output: `Fichier supprimé : ${rel(ctx.root, r.path)}.`,
          isError: false,
          summary: { path: rel(ctx.root, r.path), added: 0, removed: (original ?? '').split('\n').length }
        }
      }

      case 'run_command': {
        const command = String(input.command).trim()
        if (!command) return { output: 'Commande vide.', isError: true }
        const allowed = isCommandAllowed(command, ctx.settings) || (await ctx.approve(command))
        if (!allowed) {
          return { output: 'L’utilisateur a refusé l’exécution de cette commande.', isError: true, summary: { command } }
        }
        const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const off = window.api.agent.onOutput((cid, chunk) => cid === id && ctx.onCommandOutput(chunk))
        ctx.setCommandId(id)
        try {
          const timeout = Math.min(Number(input.timeout_seconds ?? ctx.settings.commandTimeout), 3600)
          const res = await window.api.agent.run(id, command, ctx.root, timeout)
          const status = res.killed
            ? 'Commande arrêtée par l’utilisateur.'
            : res.timedOut
              ? `Délai dépassé (${timeout} s) : commande arrêtée.`
              : `Code de retour : ${res.exitCode}`
          return {
            output: `${status}\n\n${truncateOutput(res.output.trim() || '(aucune sortie)')}`,
            isError: res.exitCode !== 0,
            summary: { command, exitCode: res.exitCode }
          }
        } finally {
          off()
          ctx.setCommandId(null)
        }
      }

      case 'get_problems': {
        const target = input.path ? resolve(input.path) : null
        if (target && 'error' in target) return { output: target.error, isError: true }
        const markers = monaco.editor
          .getModelMarkers({})
          .filter((m) => m.resource.scheme === 'file' && (!target || m.resource.fsPath === target.path))
        const sev = (s: monaco.MarkerSeverity) => (s === monaco.MarkerSeverity.Error ? 'erreur' : s === monaco.MarkerSeverity.Warning ? 'avertissement' : 'info')
        const lines = markers.map((m) => `${rel(ctx.root, m.resource.fsPath)}:${m.startLineNumber}:${m.startColumn} ${sev(m.severity)} : ${m.message}`)
        return {
          output: lines.length
            ? lines.join('\n')
            : 'Aucun problème signalé par l’éditeur (seuls les fichiers ouverts sont analysés ; lance le compilateur ou les tests pour une vérification complète).',
          isError: false
        }
      }

      default:
        return { output: `Outil inconnu : ${call.name}`, isError: true }
    }
  } catch (err) {
    return { output: `Erreur : ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

async function executeMcpTool(call: ToolCall, ref: McpToolRef, ctx: ToolContext): Promise<ToolOutcome> {
  const args = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? (call.input as Record<string, unknown>) : {}
  const summary = { command: `${ref.server} › ${ref.tool}` }
  if (!ref.autoApprove) {
    const ok = await ctx.approve(`${ref.server} › ${ref.tool}\n${JSON.stringify(args, null, 2)}`, ref)
    if (!ok) return { output: 'L’utilisateur a refusé l’exécution de cet outil.', isError: true, summary }
  }
  try {
    const res = await window.api.mcp.call(ref.source, ref.server, ref.tool, args)
    return { output: truncateOutput(res.text), isError: res.isError, summary }
  } catch (err) {
    return { output: `Erreur MCP : ${err instanceof Error ? err.message : String(err)}`, isError: true, summary }
  }
}

/** Libellé lisible d'un appel d'outil, pour l'interface. */
export function describeTool(call: ToolCall): { icon: string; label: string } {
  const input = (call.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === 'string' ? input.path : ''
  switch (call.name) {
    case 'list_dir':
      return { icon: 'folder-opened', label: `Exploration de ${path || '.'}` }
    case 'read_file':
      return { icon: 'eye', label: `Lecture de ${path}${input.start_line ? ` (lignes ${input.start_line}-${input.end_line ?? '…'})` : ''}` }
    case 'search_text':
      return { icon: 'search', label: `Recherche de « ${String(input.query ?? '')} »` }
    case 'find_files':
      return { icon: 'search', label: `Recherche de fichiers « ${String(input.pattern ?? '')} »` }
    case 'codebase_search':
      return { icon: 'database', label: `Recherche dans le projet : « ${String(input.query ?? '')} »` }
    case 'edit_file':
      return { icon: 'edit', label: `Modification de ${path}` }
    case 'write_file':
      return { icon: 'new-file', label: `Écriture de ${path}` }
    case 'delete_file':
      return { icon: 'trash', label: `Suppression de ${path}` }
    case 'run_command':
      return { icon: 'terminal', label: String(input.command ?? '') }
    case 'get_problems':
      return { icon: 'warning', label: path ? `Problèmes de ${basename(path)}` : 'Lecture des problèmes' }
    default:
      if (call.name.startsWith('mcp__')) {
        const [, server, ...tool] = call.name.split('__')
        return { icon: 'plug', label: `${server} › ${tool.join('__')}` }
      }
      return { icon: 'tools', label: call.name }
  }
}
