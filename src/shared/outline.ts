// Structure d'un fichier (classes, fonctions, méthodes…) par analyse légère, sans serveur de langage.

export type OutlineKind = 'class' | 'interface' | 'function' | 'method' | 'type' | 'struct'

export interface OutlineItem {
  name: string
  kind: OutlineKind
  line: number
  depth: number
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'with', 'elif', 'new', 'await', 'typeof'])

const PATTERNS: Array<{ re: RegExp; kind: OutlineKind | ((indent: string) => OutlineKind) }> = [
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^(\s*)(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^(\s*)(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/, kind: 'type' },
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^(\s*)(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function' },
  // Python
  { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: (indent) => (indent ? 'method' : 'function') },
  // Go, Rust
  { re: /^(\s*)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: (indent) => (indent ? 'method' : 'function') },
  { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, kind: 'struct' },
  { re: /^(\s*)type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: 'struct' },
  // Méthodes de classe (JS/TS/Java/C#…) : nom( … ) { en retrait.
  {
    re: /^(\s+)(?:(?:public|private|protected|static|async|override|readonly|get|set|final|virtual)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^;]*\)\s*(?::\s*[^{=;]+)?\s*\{\s*$/,
    kind: 'method'
  }
]

export function extractOutline(text: string, max = 200): OutlineItem[] {
  const out: OutlineItem[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i]
    if (line.length > 400 || /^\s*(\/\/|#|\*|\/\*)/.test(line)) continue
    for (const p of PATTERNS) {
      const m = p.re.exec(line)
      if (!m || KEYWORDS.has(m[2])) continue
      const indent = m[1]
      out.push({ name: m[2], kind: typeof p.kind === 'function' ? p.kind(indent) : p.kind, line: i + 1, depth: indent.replace(/\t/g, '  ').length > 0 ? 1 : 0 })
      break
    }
  }
  return out
}
