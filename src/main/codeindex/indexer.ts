import { Bm25Index } from './bm25'
import { chunkFile, isIndexable, type Chunk } from './chunker'
import { decodeVector, dot, encodeVector, normalize, reciprocalRankFusion } from './vectors'
import type { IndexStatus, SearchHit } from '@shared/codeindex'

export type { IndexState, IndexStatus, SearchHit } from '@shared/codeindex'

export type Embedder = (texts: string[], inputType: 'document' | 'query') => Promise<number[][]>

export interface IndexDeps {
  root: string
  /** Fichiers du projet (chemins relatifs, séparateurs « / »). */
  listFiles(): Promise<string[]>
  stat(rel: string): Promise<{ mtime: number; size: number } | null>
  readFile(rel: string): Promise<string>
  load(): Promise<PersistedIndex | null>
  save(data: PersistedIndex): Promise<void>
  onStatus?(status: IndexStatus): void
}

interface StoredChunk extends Chunk {
  vector?: Float32Array
}

export interface PersistedIndex {
  version: 1
  root: string
  embeddingKey: string | null
  embeddingsEnabled: boolean
  files: Record<string, { mtime: number; size: number }>
  chunks: Array<{ p: string; s: number; e: number; t: string; v?: string }>
}

const MAX_FILE_SIZE = 512 * 1024
const MAX_FILES = 20_000
const BATCH_TEXTS = 64
const BATCH_CHARS = 60_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Texte envoyé au modèle d'embeddings : le chemin aide à situer l'extrait. */
function embeddingText(c: Chunk): string {
  return `Fichier : ${c.path} (lignes ${c.startLine}-${c.endLine})\n${c.text}`
}

/**
 * Index du code d'un projet : recherche lexicale (BM25, toujours locale) et, si l'utilisateur
 * l'active, recherche sémantique par embeddings, combinées par fusion de classements.
 */
export class CodebaseIndex {
  private chunks: Array<StoredChunk | null> = []
  private byFile = new Map<string, { mtime: number; size: number; ids: number[] }>()
  private bm25 = new Bm25Index()
  private embedder: Embedder | null = null
  private embeddingKey: string | null = null
  private embeddingsEnabled = false
  private generation = 0
  private running: Promise<void> | null = null
  private status: IndexStatus

  constructor(private readonly deps: IndexDeps) {
    this.status = {
      root: deps.root,
      state: 'idle',
      files: 0,
      chunks: 0,
      embedded: 0,
      embeddingModel: null,
      embeddingsEnabled: false,
      pendingTokens: 0
    }
  }

  getStatus(): IndexStatus {
    return { ...this.status }
  }

  private emit(patch: Partial<IndexStatus> = {}): void {
    let embedded = 0
    let pendingChars = 0
    let count = 0
    for (const c of this.chunks) {
      if (!c) continue
      count++
      if (c.vector) embedded++
      else pendingChars += c.text.length
    }
    this.status = {
      ...this.status,
      files: this.byFile.size,
      chunks: count,
      embedded,
      embeddingModel: this.embeddingKey,
      embeddingsEnabled: this.embeddingsEnabled,
      pendingTokens: Math.ceil(pendingChars / 4),
      ...patch
    }
    this.deps.onStatus?.(this.getStatus())
  }

  /**
   * Définit le modèle d'embeddings (null pour le retirer). Un changement de modèle invalide
   * les vecteurs existants, qui ne sont pas comparables entre modèles.
   */
  setEmbedder(embedder: Embedder | null, key: string | null): void {
    this.embedder = embedder
    if (key !== this.embeddingKey) {
      for (const c of this.chunks) if (c) delete c.vector
      this.embeddingKey = key
    }
    this.emit()
  }

  /** Autorise (ou non) l'envoi du code au fournisseur d'embeddings pour ce projet. */
  setEmbeddingsEnabled(enabled: boolean): void {
    this.embeddingsEnabled = enabled
    this.emit()
  }

  private addChunks(rel: string, content: string): number[] {
    const ids: number[] = []
    for (const chunk of chunkFile(rel, content)) {
      const id = this.chunks.length
      this.chunks.push(chunk)
      const docId = this.bm25.add(`${chunk.path}\n${chunk.text}`)
      if (docId !== id) throw new Error('Index incohérent')
      ids.push(id)
    }
    return ids
  }

  private removeFile(rel: string): void {
    const rec = this.byFile.get(rel)
    if (!rec) return
    for (const id of rec.ids) {
      this.chunks[id] = null
      this.bm25.remove(id)
    }
    this.byFile.delete(rel)
  }

  private async indexFile(rel: string, stat: { mtime: number; size: number }): Promise<void> {
    let content: string
    try {
      content = await this.deps.readFile(rel)
    } catch {
      return
    }
    if (content.slice(0, 8000).includes('\u0000')) return
    this.removeFile(rel)
    this.byFile.set(rel, { ...stat, ids: this.addChunks(rel, content) })
  }

  /** Charge l'index enregistré (si le modèle d'embeddings est le même, les vecteurs sont repris). */
  async load(): Promise<void> {
    const data = await this.deps.load()
    if (!data || data.version !== 1 || data.root !== this.deps.root) return
    this.embeddingsEnabled = data.embeddingsEnabled
    const keepVectors = data.embeddingKey === this.embeddingKey
    const ids = new Map<string, number[]>()
    for (const c of data.chunks) {
      const id = this.chunks.length
      const chunk: StoredChunk = { path: c.p, startLine: c.s, endLine: c.e, text: c.t }
      if (keepVectors && c.v) chunk.vector = decodeVector(c.v)
      this.chunks.push(chunk)
      this.bm25.add(`${chunk.path}\n${chunk.text}`)
      ids.set(c.p, [...(ids.get(c.p) ?? []), id])
    }
    for (const [rel, stat] of Object.entries(data.files)) this.byFile.set(rel, { ...stat, ids: ids.get(rel) ?? [] })
    this.emit({ state: 'ready' })
  }

  private async persist(): Promise<void> {
    const chunks: PersistedIndex['chunks'] = []
    const files: PersistedIndex['files'] = {}
    for (const [rel, rec] of this.byFile) {
      files[rel] = { mtime: rec.mtime, size: rec.size }
      for (const id of rec.ids) {
        const c = this.chunks[id]
        if (c) chunks.push({ p: c.path, s: c.startLine, e: c.endLine, t: c.text, ...(c.vector ? { v: encodeVector(c.vector) } : {}) })
      }
    }
    await this.deps.save({
      version: 1,
      root: this.deps.root,
      embeddingKey: this.embeddingKey,
      embeddingsEnabled: this.embeddingsEnabled,
      files,
      chunks
    })
  }

  /** Compacte la table des extraits quand trop d'entrées ont été supprimées. */
  private compact(): void {
    const live = this.chunks.filter(Boolean).length
    if (this.chunks.length < 1000 || live > this.chunks.length * 0.6) return
    const old = this.chunks
    this.chunks = []
    this.bm25 = new Bm25Index()
    for (const [rel, rec] of this.byFile) {
      const ids: number[] = []
      for (const id of rec.ids) {
        const c = old[id]
        if (!c) continue
        ids.push(this.chunks.length)
        this.chunks.push(c)
        this.bm25.add(`${c.path}\n${c.text}`)
      }
      this.byFile.set(rel, { ...rec, ids })
    }
  }

  /** Synchronise l'index avec le disque (seuls les fichiers modifiés sont relus), puis calcule les embeddings manquants. */
  sync(): Promise<void> {
    const gen = ++this.generation
    const task = (async () => {
      if (this.running) await this.running.catch(() => {})
      if (gen !== this.generation) return
      try {
        this.emit({ state: 'scanning', error: undefined })
        const files = (await this.deps.listFiles()).filter(isIndexable).slice(0, MAX_FILES)
        const present = new Set(files)
        for (const rel of [...this.byFile.keys()]) if (!present.has(rel)) this.removeFile(rel)
        let done = 0
        for (const rel of files) {
          if (gen !== this.generation) return
          const stat = await this.deps.stat(rel)
          done++
          if (!stat || stat.size > MAX_FILE_SIZE) {
            this.removeFile(rel)
            continue
          }
          const prev = this.byFile.get(rel)
          if (prev && prev.mtime === stat.mtime && prev.size === stat.size) continue
          await this.indexFile(rel, stat)
          if (done % 200 === 0) this.emit({ progress: { done, total: files.length } })
        }
        this.compact()
        await this.persist()
        await this.embedMissing(gen)
        if (gen === this.generation) this.emit({ state: 'ready', progress: undefined, updatedAt: Date.now() })
      } catch (err) {
        if (gen === this.generation) this.emit({ state: 'error', error: err instanceof Error ? err.message : String(err), progress: undefined })
      }
    })()
    this.running = task
    return task
  }

  /** Met à jour quelques fichiers après une modification (surveillance du disque). */
  async update(rels: string[]): Promise<void> {
    if (this.running) await this.running.catch(() => {})
    for (const rel of new Set(rels)) {
      if (!isIndexable(rel)) continue
      const stat = await this.deps.stat(rel)
      if (!stat || stat.size > MAX_FILE_SIZE) this.removeFile(rel)
      else {
        const prev = this.byFile.get(rel)
        if (!prev || prev.mtime !== stat.mtime || prev.size !== stat.size) await this.indexFile(rel, stat)
      }
    }
    this.emit()
    const gen = this.generation
    await this.embedMissing(gen).catch((err) => this.emit({ state: 'error', error: err instanceof Error ? err.message : String(err) }))
    await this.persist()
  }

  private async embedMissing(gen: number): Promise<void> {
    if (!this.embedder || !this.embeddingsEnabled) return
    const missing = this.chunks.map((c, id) => ({ c, id })).filter((x): x is { c: StoredChunk; id: number } => !!x.c && !x.c.vector)
    if (missing.length === 0) return
    let done = 0
    this.emit({ state: 'embedding', progress: { done, total: missing.length } })
    let batchesSinceSave = 0
    for (let i = 0; i < missing.length; ) {
      if (gen !== this.generation) return
      const batch: typeof missing = []
      let chars = 0
      while (i < missing.length && batch.length < BATCH_TEXTS && (batch.length === 0 || chars + missing[i].c.text.length <= BATCH_CHARS)) {
        chars += missing[i].c.text.length
        batch.push(missing[i++])
      }
      const vectors = await this.withRetry(() => this.embedder!(batch.map((b) => embeddingText(b.c)), 'document'))
      batch.forEach((b, j) => {
        // L'extrait a pu être remplacé entre-temps : on ne range le vecteur que s'il est toujours là.
        if (this.chunks[b.id] === b.c && vectors[j]) b.c.vector = normalize(vectors[j])
      })
      done += batch.length
      this.emit({ state: 'embedding', progress: { done, total: missing.length } })
      if (++batchesSinceSave >= 10) {
        batchesSinceSave = 0
        await this.persist()
      }
    }
    await this.persist()
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let delay = 2000
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const code = (err as { code?: string }).code
        if (attempt >= 3 || (code !== 'rate_limit' && code !== 'server' && code !== 'network')) throw err
        await sleep(delay)
        delay *= 2
      }
    }
  }

  /** Recherche hybride : mots-clés (BM25) + similarité sémantique si des vecteurs existent. */
  async search(query: string, limit = 10): Promise<SearchHit[]> {
    if (this.running && this.status.state === 'scanning') await this.running.catch(() => {})
    const lexical = this.bm25.search(query, 50).map((r) => r.id)
    let semantic: number[] = []
    if (this.embedder && this.embeddingsEnabled && this.chunks.some((c) => c?.vector)) {
      try {
        const [q] = await this.embedder([query], 'query')
        const qv = normalize(q)
        semantic = this.chunks
          .map((c, id) => ({ id, s: c?.vector ? dot(qv, c.vector) : -Infinity }))
          .filter((x) => x.s > -Infinity)
          .sort((a, b) => b.s - a.s)
          .slice(0, 50)
          .map((x) => x.id)
      } catch {
        // En cas d'échec du fournisseur, on se contente de la recherche lexicale.
      }
    }
    const ranked = semantic.length ? reciprocalRankFusion([lexical, semantic]) : lexical.map((id, i) => ({ id, score: 1 / (60 + i + 1) }))
    const hits: SearchHit[] = []
    for (const { id, score } of ranked) {
      const c = this.chunks[id]
      if (!c) continue
      hits.push({ path: c.path, startLine: c.startLine, endLine: c.endLine, text: c.text, score })
      if (hits.length >= limit) break
    }
    return hits
  }

  /** Arrête les traitements en cours (fermeture du projet). */
  dispose(): void {
    this.generation++
  }
}
