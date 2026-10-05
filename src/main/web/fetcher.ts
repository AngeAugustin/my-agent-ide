import { clip, extractLinks, extractTitle, htmlToText, isHttpUrl, parseDuckDuckGo, type SearchProviderId, type WebPage, type WebSearchResult } from '@shared/web'

const USER_AGENT = 'Mozilla/5.0 (compatible; MyAgentIDE/0.1; +https://github.com/AngeAugustin/my-agent-ide)'
const MAX_BYTES = 4 * 1024 * 1024

export interface RawPage {
  url: string
  title: string
  text: string
  /** HTML brut (pour suivre les liens), absent pour les autres formats. */
  html?: string
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    chunks.push(value)
    if (size >= max) {
      await reader.cancel()
      break
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
}

/** Télécharge une page et la convertit en texte. */
export async function fetchRaw(url: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<RawPage> {
  if (!isHttpUrl(url)) throw new Error(`Adresse non prise en charge : ${url} (http ou https uniquement).`)
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5', 'Accept-Language': 'fr,en;q=0.8' },
    redirect: 'follow',
    signal: signal ?? AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`La page a répondu ${res.status} ${res.statusText} (${url}).`)
  const type = res.headers.get('content-type') ?? ''
  const finalUrl = res.url || url
  if (/image|video|audio|font|octet-stream|zip|pdf/i.test(type)) throw new Error(`Contenu non textuel (${type.split(';')[0]}) : ${url}`)
  const body = await readLimited(res, MAX_BYTES)
  if (/html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
    return { url: finalUrl, title: extractTitle(body) || finalUrl, text: htmlToText(body), html: body }
  }
  if (/json/i.test(type)) {
    try {
      return { url: finalUrl, title: finalUrl, text: JSON.stringify(JSON.parse(body), null, 2) }
    } catch {
      // JSON invalide : texte brut
    }
  }
  return { url: finalUrl, title: finalUrl, text: body }
}

export async function fetchPage(url: string, maxChars = 60_000, fetchImpl?: typeof fetch): Promise<WebPage> {
  const raw = await fetchRaw(url, undefined, fetchImpl)
  const { text, truncated } = clip(raw.text, maxChars)
  return { url: raw.url, title: raw.title, text, truncated }
}

export { extractLinks }

/** Recherche sur le web avec le moteur choisi. */
export async function webSearch(
  provider: SearchProviderId,
  key: string | null,
  query: string,
  count = 6,
  fetchImpl: typeof fetch = fetch
): Promise<WebSearchResult[]> {
  const q = query.trim()
  if (!q) return []
  const signal = AbortSignal.timeout(20_000)
  if (provider === 'brave') {
    if (!key) throw new Error('Aucune clé n’est configurée pour Brave Search (Paramètres › Web et documentation).')
    const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal
    })
    if (!res.ok) throw new Error(`Brave Search a répondu ${res.status}${res.status === 401 || res.status === 403 ? ' : clé invalide' : ''}.`)
    const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
    return (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? r.url ?? '',
      url: r.url ?? '',
      snippet: htmlToText(r.description ?? '')
    }))
  }
  if (provider === 'tavily') {
    if (!key) throw new Error('Aucune clé n’est configurée pour Tavily (Paramètres › Web et documentation).')
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: count, search_depth: 'basic' }),
      signal
    })
    if (!res.ok) throw new Error(`Tavily a répondu ${res.status}${res.status === 401 || res.status === 403 ? ' : clé invalide' : ''}.`)
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
    return (data.results ?? []).slice(0, count).map((r) => ({ title: r.title ?? r.url ?? '', url: r.url ?? '', snippet: r.content ?? '' }))
  }
  const res = await fetchImpl('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(q)}&kl=fr-fr`,
    signal
  })
  if (!res.ok) throw new Error(`DuckDuckGo a répondu ${res.status}. Réessayez plus tard ou configurez Brave Search ou Tavily.`)
  const results = parseDuckDuckGo(await res.text(), count)
  if (results.length === 0) throw new Error('DuckDuckGo n’a renvoyé aucun résultat (le service limite peut-être les requêtes). Réessayez ou configurez Brave Search ou Tavily.')
  return results
}
