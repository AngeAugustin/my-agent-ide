// Web et documentation : conversion HTML → texte, analyse des résultats de recherche, découpage
// (fonctions pures, partagées et testées).

export type SearchProviderId = 'duckduckgo' | 'brave' | 'tavily'

export const SEARCH_PROVIDERS: Array<{ id: SearchProviderId; name: string; requiresKey: boolean; keyUrl?: string; description: string }> = [
  { id: 'duckduckgo', name: 'DuckDuckGo', requiresKey: false, description: 'Sans clé. Résultats moins complets, et le service peut limiter les requêtes trop fréquentes.' },
  { id: 'brave', name: 'Brave Search', requiresKey: true, keyUrl: 'https://api-dashboard.search.brave.com/app/keys', description: 'API de recherche indépendante (offre gratuite limitée).' },
  { id: 'tavily', name: 'Tavily', requiresKey: true, keyUrl: 'https://app.tavily.com/', description: 'Recherche conçue pour les agents IA (offre gratuite limitée).' }
]

/** Identifiant de la clé d'un moteur de recherche dans le coffre des clés. */
export const searchKeyId = (id: SearchProviderId) => `search:${id}`

export interface WebSettings {
  searchProvider: SearchProviderId
  /** Outils web_search et fetch_url proposés à l'agent. */
  agentTools: boolean
}

export const DEFAULT_WEB_SETTINGS: WebSettings = { searchProvider: 'duckduckgo', agentTools: true }

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebPage {
  url: string
  title: string
  text: string
  truncated: boolean
}

export interface DocSource {
  id: string
  name: string
  url: string
  maxPages: number
}

export interface DocStatus extends DocSource {
  state: 'idle' | 'indexing' | 'error'
  pages: number
  chunks: number
  indexedAt?: number
  error?: string
  progress?: { done: number; queued: number }
}

export interface DocHit {
  sourceId: string
  sourceName: string
  url: string
  title: string
  text: string
  score: number
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ecirc: 'ê',
  times: '×',
  rarr: '→',
  larr: '←',
  middot: '·',
  bull: '•'
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m
  })
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const raw = m?.[1] ?? h1?.[1] ?? ''
  return decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function inner(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i').exec(html)
  if (!open) return null
  const close = html.toLowerCase().lastIndexOf(`</${tag}>`)
  return close > open.index ? html.slice(open.index + open[0].length, close) : html.slice(open.index + open[0].length)
}

/**
 * Convertit une page HTML en texte lisible proche du Markdown (titres, listes, blocs de code).
 * On garde le contenu principal (<main>, <article>) quand il existe et on retire la navigation.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select)\b[\s\S]*?<\/\1>/gi, '')
  s = inner(s, 'main') ?? inner(s, 'article') ?? inner(s, 'body') ?? s
  s = s.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '')

  // Blocs de code : mis de côté pour conserver leurs espaces.
  const blocks: string[] = []
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    const lang = /class="[^"]*(?:language|lang)-([\w+-]+)/i.exec(body)?.[1] ?? ''
    const code = decodeEntities(body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, '')
    blocks.push(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`)
    return `\u0000${blocks.length - 1}\u0000`
  })
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => {
    const code = body.replace(/<[^>]+>/g, '')
    return code.includes('\n') ? code : `\`${code}\``
  })
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${body.replace(/<[^>]+>/g, '').trim()}\n\n`)
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(p|div|section|tr|table|ul|ol|dl|dd|dt|blockquote|figure)>/gi, '\n')
  s = s.replace(/<(p|div|section|table|tr|blockquote)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/t[dh]>/gi, ' | ')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s
    .replace(/\n*\u0000(\d+)\u0000\n*/g, (_m, i: string) => `\n${blocks[Number(i)]}\n`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Liens d'une page, absolus et sans ancre. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>()
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (!href || href.startsWith('#') || /^(mailto|javascript|tel|data):/i.test(href)) continue
    try {
      const u = new URL(href, baseUrl)
      u.hash = ''
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.toString())
    } catch {
      // lien invalide
    }
  }
  return [...out]
}

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|zip|gz|tgz|pdf|mp4|mp3|woff2?|ttf|eot|json|xml|txt)$/i

/** Préfixe d'URL que l'indexation d'une documentation ne quitte pas (le « dossier » de l'URL de départ). */
export function docScope(startUrl: string): string {
  const u = new URL(startUrl)
  u.hash = ''
  u.search = ''
  const path = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/[^/]*$/, '')
  return `${u.origin}${path}`
}

/** Vrai si un lien appartient à la documentation (même site, sous le même chemin, pas une ressource). */
export function inDocScope(url: string, scope: string): boolean {
  if (!url.startsWith(scope)) return false
  const u = new URL(url)
  return !ASSET_EXT.test(u.pathname)
}

/** Normalise une URL pour éviter de visiter deux fois la même page. */
export function canonicalUrl(url: string): string {
  const u = new URL(url)
  u.hash = ''
  if (u.pathname.endsWith('/index.html')) u.pathname = u.pathname.slice(0, -'index.html'.length)
  return u.toString()
}

/** Résultats de la version HTML de DuckDuckGo (sans clé). */
export function parseDuckDuckGo(html: string, limit = 8): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const linkRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/gi
  const anchors = html.match(linkRe) ?? []
  const snippets = html.match(/<(a|div|td)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>[\s\S]*?<\/\1>/gi) ?? []
  anchors.forEach((a, i) => {
    const href = /href="([^"]*)"/i.exec(a)?.[1]
    if (!href) return
    let url = decodeEntities(href)
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (url.startsWith('//')) url = `https:${url}`
    if (!isHttpUrl(url) || /duckduckgo\.com\/y\.js/.test(url)) return
    const title = decodeEntities(a.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    const snippet = decodeEntities((snippets[i] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    results.push({ title, url, snippet })
  })
  return results.slice(0, limit)
}

/** Découpe le texte d'une page en extraits d'environ `size` caractères, en suivant les titres et paragraphes. */
export function chunkPage(text: string, size = 1500): string[] {
  const paragraphs = text.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''
  let heading = ''
  const push = () => {
    const body = current.trim()
    if (body) chunks.push(heading && !body.startsWith(heading) ? `${heading}\n${body}` : body)
    current = ''
  }
  for (const p of paragraphs) {
    if (/^#{1,6} /.test(p)) {
      push()
      heading = p.split('\n')[0]
    }
    if (current && current.length + p.length > size) push()
    if (p.length > size * 2 && !p.startsWith('```')) {
      for (let i = 0; i < p.length; i += size) {
        current = p.slice(i, i + size)
        push()
      }
      continue
    }
    current += (current ? '\n\n' : '') + p
  }
  push()
  return chunks
}

/** Tronque un texte pour le prompt. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}\n[… ${text.length - max} caractères non inclus]`, truncated: true }
}
