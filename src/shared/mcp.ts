// Serveurs MCP (Model Context Protocol) : configuration au format de Cursor / Claude Desktop.

export interface McpServerEntry {
  /** Serveur local lancé par une commande (transport stdio). */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Serveur distant (transport HTTP « streamable »). */
  url?: string
  headers?: Record<string, string>
  /** Extensions de l'IDE : serveur désactivé, outils exécutés sans confirmation. */
  disabled?: boolean
  autoApprove?: boolean
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type McpState = 'disabled' | 'connecting' | 'connected' | 'error'

export interface McpServerStatus {
  name: string
  /** « user » : paramètres de l'IDE ; « project » : fichier .cursor/mcp.json du projet. */
  source: 'user' | 'project'
  state: McpState
  error?: string
  tools: McpToolInfo[]
  autoApprove: boolean
  /** Résumé de la commande ou de l'URL (pour l'affichage). */
  target: string
}

export const PROJECT_MCP_FILES = ['.cursor/mcp.json', '.mcp.json']

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Nom d'outil exposé au modèle : « mcp__serveur__outil » (64 caractères au plus). */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 64)
}

/** Analyse un fichier de configuration MCP (`{ "mcpServers": { … } }`) ; lève une erreur lisible. */
export function parseMcpConfig(text: string): Record<string, McpServerEntry> {
  if (!text.trim()) return {}
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new Error(`JSON invalide : ${(err as Error).message}`)
  }
  const servers = (json as { mcpServers?: unknown })?.mcpServers ?? json
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('« mcpServers » doit être un objet.')
  const out: Record<string, McpServerEntry> = {}
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const e = raw as McpServerEntry
    if (!e || typeof e !== 'object') throw new Error(`Serveur « ${name} » : configuration invalide.`)
    if (!e.command && !e.url) throw new Error(`Serveur « ${name} » : « command » ou « url » requis.`)
    if (e.args && (!Array.isArray(e.args) || e.args.some((a) => typeof a !== 'string'))) throw new Error(`Serveur « ${name} » : « args » doit être une liste de textes.`)
    if (e.url && !/^https?:\/\//.test(e.url)) throw new Error(`Serveur « ${name} » : l’URL doit commencer par http:// ou https://.`)
    out[name] = e
  }
  return out
}

export function describeTarget(e: McpServerEntry): string {
  return e.url ?? [e.command, ...(e.args ?? [])].join(' ')
}
