// Serveurs de langage (LSP) : catalogue et utilitaires partagés.

export interface LspServerDefinition {
  id: string
  name: string
  /** Extensions de fichiers prises en charge (sans le point). */
  extensions: string[]
  /** Commandes candidates, essayées dans l'ordre (la première trouvée est utilisée). */
  commands: Array<{ command: string; args: string[] }>
  /** Serveur fourni avec l'IDE (aucune installation nécessaire). */
  bundled?: boolean
  installHint?: string
}

export const LSP_SERVERS: LspServerDefinition[] = [
  {
    id: 'typescript',
    name: 'TypeScript / JavaScript',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
    commands: [],
    bundled: true
  },
  {
    id: 'python',
    name: 'Python',
    extensions: ['py', 'pyi'],
    commands: [
      { command: 'basedpyright-langserver', args: ['--stdio'] },
      { command: 'pyright-langserver', args: ['--stdio'] },
      { command: 'pylsp', args: [] }
    ],
    installHint: 'npm install -g pyright   (ou : pip install pyright)'
  },
  {
    id: 'go',
    name: 'Go',
    extensions: ['go'],
    commands: [{ command: 'gopls', args: [] }],
    installHint: 'go install golang.org/x/tools/gopls@latest'
  },
  {
    id: 'rust',
    name: 'Rust',
    extensions: ['rs'],
    commands: [{ command: 'rust-analyzer', args: [] }],
    installHint: 'rustup component add rust-analyzer'
  },
  {
    id: 'cpp',
    name: 'C / C++',
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
    commands: [{ command: 'clangd', args: [] }],
    installHint: 'Installez clangd (LLVM) via votre gestionnaire de paquets.'
  }
]

export interface LspServerStatus {
  id: string
  name: string
  extensions: string[]
  available: boolean
  /** Commande trouvée (ou « intégré »). */
  command?: string
  installHint?: string
  enabled: boolean
}

export interface LspSettings {
  enabled: boolean
  /** Serveurs désactivés par l'utilisateur. */
  disabled: string[]
}

export const DEFAULT_LSP_SETTINGS: LspSettings = { enabled: true, disabled: [] }

/** Extension d'une URI de fichier (« file:///a/b.ts » → « ts »). */
export function uriExtension(uri: string): string {
  const path = uri.split(/[?#]/)[0]
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
}

/** Indique si un serveur doit recevoir un document (fichier sur disque avec une extension prise en charge). */
export function acceptsUri(extensions: string[], uri: string | undefined): boolean {
  if (!uri) return true
  return uri.startsWith('file:') && extensions.includes(uriExtension(uri))
}

/** Découpe le flux d'un serveur de langage en messages JSON (en-têtes « Content-Length »). */
export class LspFramer {
  private buffer: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged
    const out: unknown[] = []
    const decoder = new TextDecoder()
    while (true) {
      const headerEnd = indexOf(this.buffer, [13, 10, 13, 10])
      if (headerEnd === -1) break
      const header = decoder.decode(this.buffer.slice(0, headerEnd))
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1])
      if (!Number.isFinite(length)) {
        // En-tête illisible : on abandonne ce morceau pour ne pas bloquer le flux.
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const start = headerEnd + 4
      if (this.buffer.length < start + length) break
      const body = decoder.decode(this.buffer.slice(start, start + length))
      this.buffer = this.buffer.slice(start + length)
      try {
        out.push(JSON.parse(body))
      } catch {
        // message JSON invalide : ignoré
      }
    }
    return out
  }
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

export function encodeLspMessage(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`)
  const out = new Uint8Array(header.length + body.length)
  out.set(header)
  out.set(body, header.length)
  return out
}
