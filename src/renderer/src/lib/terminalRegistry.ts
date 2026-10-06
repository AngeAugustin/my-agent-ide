import { newTerminal, useTerminals } from '../store/terminals'

interface TerminalAccess {
  read(maxLines: number): string
  ptyId(): number | null
  /** Colle comme le ferait l'utilisateur (xterm gère le mode « collage entre crochets » du shell). */
  paste(text: string): void
  focus(): void
}

const registry = new Map<number, TerminalAccess>()

export function registerTerminal(key: number, access: TerminalAccess): () => void {
  registry.set(key, access)
  return () => registry.delete(key)
}

/** Dernières lignes du terminal actif (pour le contexte @terminal). */
export function activeTerminalText(maxLines = 200): string | null {
  const key = useTerminals.getState().activeKey
  const access = key !== null ? registry.get(key) : undefined
  return access ? access.read(maxLines) : null
}

/** Colle du texte dans le terminal actif (sans l'exécuter), en créant un terminal si besoin. */
export async function pasteInTerminal(text: string): Promise<void> {
  if (useTerminals.getState().terminals.length === 0) newTerminal()
  for (let i = 0; i < 50; i++) {
    const key = useTerminals.getState().activeKey
    const pty = key !== null ? registry.get(key)?.ptyId() : null
    if (pty != null && key !== null) {
      const access = registry.get(key)!
      access.paste(text.replace(/\n+$/, ''))
      access.focus()
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Lance une commande dans le terminal actif (colle puis valide). */
export async function runInTerminal(command: string): Promise<void> {
  await pasteInTerminal(command)
  const key = useTerminals.getState().activeKey
  const pty = key !== null ? registry.get(key)?.ptyId() : null
  if (pty != null) window.api.terminal.write(pty, '\r')
}

/** Commande pour exécuter un fichier selon son type (null : type non pris en charge). */
export function runCommandFor(path: string, platform = window.api.platform): string | null {
  const q = (p: string) => (platform === 'win32' ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`)
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return `node ${q(path)}`
    case 'ts':
    case 'mts':
    case 'tsx':
      return `npx --yes tsx ${q(path)}`
    case 'py':
      return `${platform === 'win32' ? 'python' : 'python3'} ${q(path)}`
    case 'sh':
      return `bash ${q(path)}`
    case 'go':
      return `go run ${q(path)}`
    case 'rb':
      return `ruby ${q(path)}`
    case 'php':
      return `php ${q(path)}`
    default:
      return null
  }
}
