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
