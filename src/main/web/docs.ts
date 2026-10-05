import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { canonicalUrl, chunkPage, docScope, extractLinks, inDocScope, isHttpUrl, type DocHit, type DocSource, type DocStatus } from '@shared/web'
import { Bm25Index } from '../codeindex/bm25'
import { fetchRaw } from './fetcher'

interface StoredPage {
  url: string
  title: string
  chunks: string[]
}

interface Loaded {
  pages: StoredPage[]
  index: Bm25Index
  /** Identifiant BM25 → [page, extrait]. */
  refs: Array<[number, number]>
}

interface Meta {
  sources: Array<DocSource & { pages: number; chunks: number; indexedAt?: number; error?: string }>
}

/** Documentations indexées (sites web parcourus puis recherchés localement par mots-clés). */
export class DocsManager {
  private meta: Meta | null = null
  private readonly loaded = new Map<string, Loaded>()
  private readonly running = new Map<string, { controller: AbortController; done: number; queued: number }>()

  constructor(
    private readonly dir: string,
    private readonly onStatus: (statuses: DocStatus[]) => void,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async readMeta(): Promise<Meta> {
    if (this.meta) return this.meta
    try {
      this.meta = JSON.parse(await fs.readFile(join(this.dir, 'sources.json'), 'utf8')) as Meta
      if (!Array.isArray(this.meta.sources)) this.meta = { sources: [] }
    } catch {
      this.meta = { sources: [] }
    }
    return this.meta
  }

  private async writeMeta(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(join(this.dir, 'sources.json'), JSON.stringify(this.meta, null, 2), 'utf8')
  }

  async list(): Promise<DocStatus[]> {
    const meta = await this.readMeta()
    return meta.sources.map((s) => {
      const run = this.running.get(s.id)
      return {
        ...s,
        state: run ? 'indexing' : s.error ? 'error' : 'idle',
        ...(run ? { progress: { done: run.done, queued: run.queued } } : {})
      }
    })
  }

  private async emit(): Promise<void> {
    this.onStatus(await this.list())
  }

  async add(name: string, url: string, maxPages: number): Promise<DocStatus[]> {
    if (!isHttpUrl(url)) throw new Error('Adresse invalide : indiquez une URL commençant par http:// ou https://.')
    const meta = await this.readMeta()
    const id = `doc-${Date.now().toString(36)}`
    const cleanName = name.trim() || new URL(url).hostname
    if (meta.sources.some((s) => s.name.toLowerCase() === cleanName.toLowerCase())) throw new Error(`Une documentation s’appelle déjà « ${cleanName} ».`)
    meta.sources.push({ id, name: cleanName, url: url.trim(), maxPages: Math.max(1, Math.min(maxPages || 50, 500)), pages: 0, chunks: 0 })
    await this.writeMeta()
    void this.reindex(id)
    return this.list()
  }

  async remove(id: string): Promise<DocStatus[]> {
    this.running.get(id)?.controller.abort()
    const meta = await this.readMeta()
    meta.sources = meta.sources.filter((s) => s.id !== id)
    this.loaded.delete(id)
    await this.writeMeta()
    await fs.rm(join(this.dir, `${id}.json`), { force: true })
    await this.emit()
    return this.list()
  }

  /** Parcourt le site à partir de l'URL de départ (même site, même chemin), puis enregistre les extraits. */
  async reindex(id: string): Promise<void> {
    const meta = await this.readMeta()
    const source = meta.sources.find((s) => s.id === id)
    if (!source || this.running.has(id)) return
    const run = { controller: new AbortController(), done: 0, queued: 1 }
    this.running.set(id, run)
    source.error = undefined
    await this.emit()

    const scope = docScope(source.url)
    const seen = new Set<string>([canonicalUrl(source.url)])
    const queue: string[] = [source.url]
    const pages: StoredPage[] = []
    let lastEmit = 0
    let failures = 0

    let active = 0
    const worker = async () => {
      while (pages.length + active < source.maxPages && !run.controller.signal.aborted) {
        if (!queue.length) {
          // File vide : on attend les pages en cours, qui peuvent ajouter des liens.
          if (active === 0) break
          await new Promise((r) => setTimeout(r, 50))
          continue
        }
        const url = queue.shift()!
        run.queued = queue.length
        active++
        try {
          const page = await fetchRaw(url, AbortSignal.any([run.controller.signal, AbortSignal.timeout(20_000)]), this.fetchImpl)
          if (pages.length < source.maxPages && page.text.trim()) pages.push({ url: page.url, title: page.title, chunks: chunkPage(page.text) })
          if (page.html) {
            for (const link of extractLinks(page.html, page.url)) {
              const c = canonicalUrl(link)
              if (!seen.has(c) && inDocScope(c, scope)) {
                seen.add(c)
                queue.push(c)
              }
            }
          }
        } catch {
          failures++
        } finally {
          active--
        }
        run.done++
        run.queued = queue.length
        if (Date.now() - lastEmit > 300) {
          lastEmit = Date.now()
          void this.emit()
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    this.running.delete(id)

    const current = (await this.readMeta()).sources.find((s) => s.id === id)
    if (!current) return // supprimée pendant l'indexation
    if (run.controller.signal.aborted) {
      await this.emit()
      return
    }
    if (pages.length === 0) {
      current.error = failures ? 'Aucune page n’a pu être téléchargée. Vérifiez l’adresse et votre connexion.' : 'Aucun contenu texte trouvé à cette adresse.'
    } else {
      await fs.mkdir(this.dir, { recursive: true })
      await fs.writeFile(join(this.dir, `${id}.json`), JSON.stringify({ pages }), 'utf8')
      this.loaded.delete(id)
      current.pages = pages.length
      current.chunks = pages.reduce((n, p) => n + p.chunks.length, 0)
      current.indexedAt = Date.now()
    }
    await this.writeMeta()
    await this.emit()
  }

  private async load(id: string): Promise<Loaded | null> {
    const cached = this.loaded.get(id)
    if (cached) return cached
    try {
      const { pages } = JSON.parse(await fs.readFile(join(this.dir, `${id}.json`), 'utf8')) as { pages: StoredPage[] }
      const index = new Bm25Index()
      const refs: Array<[number, number]> = []
      pages.forEach((p, pi) =>
        p.chunks.forEach((c, ci) => {
          index.add(`${p.title}\n${c}`)
          refs.push([pi, ci])
        })
      )
      const loaded = { pages, index, refs }
      this.loaded.set(id, loaded)
      return loaded
    } catch {
      return null
    }
  }

  /** Extraits les plus pertinents d'une ou plusieurs documentations (toutes si `ids` est vide). */
  async search(ids: string[], query: string, limit = 8): Promise<DocHit[]> {
    const meta = await this.readMeta()
    const sources = meta.sources.filter((s) => ids.length === 0 || ids.includes(s.id))
    const hits: DocHit[] = []
    for (const s of sources) {
      const data = await this.load(s.id)
      if (!data) continue
      for (const { id, score } of data.index.search(query, limit)) {
        const [pi, ci] = data.refs[id]
        const page = data.pages[pi]
        hits.push({ sourceId: s.id, sourceName: s.name, url: page.url, title: page.title, text: page.chunks[ci], score })
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.controller.abort()
  }
}
