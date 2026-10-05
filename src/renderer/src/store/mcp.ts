import { create } from 'zustand'
import type { ToolDefinition } from '@shared/ai'
import { mcpToolName, type McpServerStatus } from '@shared/mcp'
import { updateSettings, useIde } from './ide'

export const useMcp = create<{ servers: McpServerStatus[] }>()(() => ({ servers: [] }))

let initialized = false

export function syncMcp(): Promise<void> {
  return window.api.mcp.sync(useIde.getState().workspace).then((servers) => useMcp.setState({ servers }))
}

export function initMcp(): void {
  if (initialized) return
  initialized = true
  window.api.mcp.onStatus((servers) => useMcp.setState({ servers }))
  void syncMcp()
  useIde.subscribe((s, prev) => {
    if (
      s.workspace !== prev.workspace ||
      s.settings.mcpServers !== prev.settings.mcpServers ||
      s.settings.mcpProjectEnabled !== prev.settings.mcpProjectEnabled
    ) {
      // Laisse l'enregistrement des paramètres se terminer avant de resynchroniser.
      setTimeout(() => void syncMcp(), 100)
    }
  })
}

export interface McpToolRef {
  source: 'user' | 'project'
  server: string
  tool: string
  autoApprove: boolean
}

/** Outils des serveurs connectés, au format des outils de l'agent, avec leur correspondance. */
export function mcpTools(): { definitions: ToolDefinition[]; refs: Map<string, McpToolRef> } {
  const definitions: ToolDefinition[] = []
  const refs = new Map<string, McpToolRef>()
  for (const s of useMcp.getState().servers) {
    if (s.state !== 'connected') continue
    for (const t of s.tools) {
      const name = mcpToolName(s.name, t.name)
      if (refs.has(name)) continue
      refs.set(name, { source: s.source, server: s.name, tool: t.name, autoApprove: s.autoApprove })
      definitions.push({ name, description: `[MCP ${s.name}] ${t.description}`.slice(0, 1024), inputSchema: t.inputSchema })
    }
  }
  return { definitions, refs }
}

/** Active ou désactive l'exécution sans confirmation des outils d'un serveur. */
export function setAutoApprove(source: 'user' | 'project', name: string, value: boolean): Promise<void> {
  const settings = useIde.getState().settings
  if (source === 'user') {
    const entry = settings.mcpServers[name]
    if (!entry) return Promise.resolve()
    return updateSettings({ mcpServers: { ...settings.mcpServers, [name]: { ...entry, autoApprove: value } } })
  }
  // Pour un serveur de projet, la préférence est mémorisée côté utilisateur, jamais dans le dépôt.
  const key = `project:${useIde.getState().workspace}:${name}`
  const auto = new Set(settings.mcpProjectEnabled[key] ?? [])
  if (value) auto.add('autoApprove')
  else auto.delete('autoApprove')
  return updateSettings({ mcpProjectEnabled: { ...settings.mcpProjectEnabled, [key]: [...auto] } })
}

export function setProjectServerEnabled(name: string, enabled: boolean): Promise<void> {
  const { settings, workspace } = useIde.getState()
  if (!workspace) return Promise.resolve()
  const current = new Set(settings.mcpProjectEnabled[workspace] ?? [])
  if (enabled) current.add(name)
  else current.delete(name)
  return updateSettings({ mcpProjectEnabled: { ...settings.mcpProjectEnabled, [workspace]: [...current] } })
}
