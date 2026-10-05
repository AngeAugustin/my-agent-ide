import { ipcMain, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Settings } from '@shared/types'
import { describeTarget, parseMcpConfig, PROJECT_MCP_FILES, type McpServerEntry, type McpServerStatus } from '@shared/mcp'

interface Connection {
  key: string
  entry: McpServerEntry
  status: McpServerStatus
  client?: Client
  close?: () => Promise<void>
}

const connections = new Map<string, Connection>()
const MAX_RESULT = 60_000

/** Lit la configuration MCP du projet (.cursor/mcp.json ou .mcp.json). */
async function projectServers(root: string | null): Promise<Record<string, McpServerEntry>> {
  if (!root) return {}
  for (const file of PROJECT_MCP_FILES) {
    try {
      return parseMcpConfig(await fs.readFile(join(root, file), 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return {}
    }
  }
  return {}
}

async function connect(conn: Connection, cwd: string | undefined, notify: () => void): Promise<void> {
  conn.status = { ...conn.status, state: 'connecting', error: undefined, tools: [] }
  notify()
  const client = new Client({ name: 'my-agent-ide', version: '0.1.0' })
  let stderr = ''
  try {
    if (conn.entry.url) {
      const transport = new StreamableHTTPClientTransport(new URL(conn.entry.url), {
        requestInit: { headers: conn.entry.headers ?? {} }
      })
      await client.connect(transport)
    } else {
      const transport = new StdioClientTransport({
        command: conn.entry.command!,
        args: conn.entry.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(conn.entry.env ?? {}) },
        cwd,
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-2000)
      })
      await client.connect(transport)
    }
    const tools = await client.listTools()
    conn.client = client
    conn.close = () => client.close()
    conn.status = {
      ...conn.status,
      state: 'connected',
      tools: tools.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown> }))
    }
  } catch (err) {
    await client.close().catch(() => {})
    const detail = stderr.trim().split('\n').slice(-3).join(' ')
    conn.status = { ...conn.status, state: 'error', error: `${(err as Error).message}${detail ? ` — ${detail}` : ''}` }
  }
  notify()
}

export function registerMcpHandlers(getContents: () => WebContents | null, getSettings: () => Promise<Settings>): void {
  const statuses = () => [...connections.values()].map((c) => c.status)
  const notify = () => getContents()?.send('mcp:status', statuses())

  /** Aligne les connexions sur la configuration (paramètres + projet autorisé). */
  async function sync(root: string | null): Promise<McpServerStatus[]> {
    const settings = await getSettings()
    const wanted = new Map<string, { entry: McpServerEntry; source: 'user' | 'project'; enabled: boolean }>()
    for (const [name, entry] of Object.entries(settings.mcpServers ?? {})) wanted.set(`user:${name}`, { entry, source: 'user', enabled: !entry.disabled })
    const trusted = root ? (settings.mcpProjectEnabled?.[root] ?? []) : []
    for (const [name, entry] of Object.entries(await projectServers(root))) {
      // Un projet ne peut pas lancer de commande sans l'accord explicite de l'utilisateur.
      wanted.set(`project:${name}`, { entry, source: 'project', enabled: trusted.includes(name) && !entry.disabled })
    }

    for (const [key, conn] of connections) {
      const w = wanted.get(key)
      if (!w || !w.enabled || JSON.stringify(w.entry) !== JSON.stringify(conn.entry)) {
        await conn.close?.().catch(() => {})
        connections.delete(key)
      }
    }
    for (const [key, w] of wanted) {
      const name = key.slice(key.indexOf(':') + 1)
      // Un fichier de projet ne peut pas s'auto-approuver : seul le choix de l'utilisateur compte.
      const autoApprove =
        w.source === 'user' ? !!w.entry.autoApprove : !!settings.mcpProjectEnabled?.[`project:${root}:${name}`]?.includes('autoApprove')
      const base: McpServerStatus = {
        name,
        source: w.source,
        state: 'disabled',
        tools: [],
        autoApprove,
        target: describeTarget(w.entry)
      }
      if (!w.enabled) {
        connections.set(key, { key, entry: w.entry, status: base })
        continue
      }
      const existing = connections.get(key)
      if (existing && existing.status.state !== 'disabled') {
        existing.status = { ...existing.status, autoApprove: base.autoApprove }
        continue
      }
      const conn: Connection = { key, entry: w.entry, status: base }
      connections.set(key, conn)
      void connect(conn, root ?? undefined, notify)
    }
    notify()
    return statuses()
  }

  ipcMain.handle('mcp:sync', (_e, root: string | null) => sync(root))
  ipcMain.handle('mcp:status', () => statuses())
  ipcMain.handle('mcp:reconnect', async (_e, source: 'user' | 'project', name: string, root: string | null) => {
    const conn = connections.get(`${source}:${name}`)
    if (conn && conn.status.state !== 'disabled') {
      await conn.close?.().catch(() => {})
      await connect(conn, root ?? undefined, notify)
    }
    return statuses()
  })
  ipcMain.handle('mcp:call', async (_e, source: 'user' | 'project', server: string, tool: string, args: Record<string, unknown>) => {
    const conn = connections.get(`${source}:${server}`)
    if (!conn?.client || conn.status.state !== 'connected') return { isError: true, text: `Le serveur MCP « ${server} » n’est pas connecté.` }
    try {
      const result = (await conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 })) as {
        content?: Array<{ type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }>
        isError?: boolean
        structuredContent?: unknown
      }
      const parts = (result.content ?? []).map((c) =>
        c.type === 'text' ? (c.text ?? '') : c.type === 'resource' ? (c.resource?.text ?? `[ressource ${c.resource?.uri ?? ''}]`) : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`
      )
      let text = parts.join('\n') || (result.structuredContent ? JSON.stringify(result.structuredContent, null, 2) : '(aucun contenu)')
      if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n[… résultat tronqué]`
      return { isError: !!result.isError, text }
    } catch (err) {
      return { isError: true, text: `Erreur MCP : ${(err as Error).message}` }
    }
  })
}

export async function closeAllMcp(): Promise<void> {
  await Promise.all([...connections.values()].map((c) => c.close?.().catch(() => {})))
  connections.clear()
}
