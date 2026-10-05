import { describe, expect, it } from 'vitest'
import { chunkFile, isIndexable } from '../src/main/codeindex/chunker'
import { Bm25Index, tokenize } from '../src/main/codeindex/bm25'
import { decodeVector, dot, encodeVector, normalize, reciprocalRankFusion } from '../src/main/codeindex/vectors'
import { CodebaseIndex, type PersistedIndex } from '../src/main/codeindex/indexer'
import { embedTexts } from '../src/main/ai/providers/embeddings'
import { BUILTIN_PROVIDERS } from '../src/shared/ai'
import type { ProviderConfig } from '../src/main/ai/providers/types'

describe('chunkFile', () => {
  it('couvre tout le fichier sans chevauchement', () => {
    const lines = Array.from({ length: 250 }, (_, i) => (i % 40 === 0 ? `export function f${i}() {` : `  ligne ${i}`))
    const chunks = chunkFile('a.ts', lines.join('\n'))
    expect(chunks[0].startLine).toBe(1)
    expect(chunks.at(-1)!.endLine).toBe(250)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1)
    expect(chunks.every((c) => c.endLine - c.startLine < 100)).toBe(true)
  })

  it('coupe de préférence au début d’une déclaration', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `  x${i}()`)
    const content = ['function a() {', ...body(55), '}', 'function b() {', ...body(30), '}'].join('\n')
    const chunks = chunkFile('a.js', content)
    expect(chunks[1].text.startsWith('function b()')).toBe(true)
  })

  it('n’indexe ni binaires, ni verrous, ni fichiers minifiés', () => {
    expect(isIndexable('src/app.ts')).toBe(true)
    expect(isIndexable('logo.png')).toBe(false)
    expect(isIndexable('package-lock.json')).toBe(false)
    expect(isIndexable('dist/app.min.js')).toBe(false)
  })
})

describe('BM25', () => {
  it('découpe camelCase et snake_case', () => {
    expect(tokenize('getUserName user_id')).toEqual(expect.arrayContaining(['getusername', 'get', 'user', 'name', 'user_id', 'id']))
  })

  it('classe le document le plus pertinent en premier et gère les suppressions', () => {
    const idx = new Bm25Index()
    const a = idx.add('function login(user, password) { checkPassword(password) }')
    const b = idx.add('function render() { return html }')
    idx.add('const password = hash(input)')
    expect(idx.search('login password', 3)[0].id).toBe(a)
    idx.remove(a)
    expect(idx.search('login', 3).find((r) => r.id === a)).toBeUndefined()
    expect(idx.search('render', 1)[0].id).toBe(b)
    expect(idx.size).toBe(2)
  })
})

describe('vecteurs', () => {
  it('normalise, sérialise et fusionne les classements', () => {
    const v = normalize([3, 4])
    expect(dot(v, v)).toBeCloseTo(1)
    expect(Array.from(decodeVector(encodeVector(v)))).toEqual(Array.from(v))
    const fused = reciprocalRankFusion([
      [1, 2, 3],
      [3, 1, 4]
    ])
    expect(fused[0].id).toBe(1)
    expect(fused.map((f) => f.id)).toEqual(expect.arrayContaining([1, 2, 3, 4]))
  })
})

/** Projet en mémoire pour tester l'index sans disque. */
function memoryProject(files: Record<string, string>) {
  const mtimes: Record<string, number> = Object.fromEntries(Object.keys(files).map((f) => [f, 1]))
  let saved: PersistedIndex | null = null
  let reads = 0
  const deps = {
    root: '/projet',
    listFiles: async () => Object.keys(files),
    stat: async (rel: string) => (rel in files ? { mtime: mtimes[rel], size: files[rel].length } : null),
    readFile: async (rel: string) => {
      reads++
      return files[rel]
    },
    load: async () => saved,
    save: async (d: PersistedIndex) => void (saved = JSON.parse(JSON.stringify(d)))
  }
  return {
    deps,
    touch: (rel: string, content: string) => {
      files[rel] = content
      mtimes[rel] = (mtimes[rel] ?? 0) + 1
    },
    remove: (rel: string) => delete files[rel],
    reads: () => reads,
    saved: () => saved
  }
}

// « Embeddings » factices : un axe par thème, pour tester la recherche par le sens.
const THEMES = ['auth', 'paiement', 'affichage']
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => {
      const l = t.toLowerCase()
      return [
        /login|password|session|connexion|authentif/.test(l) ? 1 : 0,
        /stripe|invoice|paiement|facture|carte/.test(l) ? 1 : 0,
        /render|html|affich|vue/.test(l) ? 1 : 0
      ].map((x) => x + 0.01)
    })
  )
}

describe('CodebaseIndex', () => {
  const files = {
    'src/auth.ts': 'export function login(user: string, password: string) {\n  return checkSession(user, password)\n}',
    'src/billing.ts': 'export function chargeCard(amount: number) {\n  return stripe.charge(amount)\n}',
    'src/view.ts': 'export function render() {\n  return "<div>html</div>"\n}'
  }

  it('indexe, ne relit que les fichiers modifiés et suit les suppressions', async () => {
    const p = memoryProject({ ...files })
    const index = new CodebaseIndex(p.deps)
    await index.sync()
    expect(index.getStatus()).toMatchObject({ state: 'ready', files: 3, chunks: 3, embedded: 0 })
    const readsAfterFirst = p.reads()
    await index.sync()
    expect(p.reads()).toBe(readsAfterFirst)
    p.touch('src/view.ts', 'export function paint() { return canvas }')
    p.remove('src/billing.ts')
    await index.sync()
    expect(p.reads()).toBe(readsAfterFirst + 1)
    expect(index.getStatus().files).toBe(2)
    expect((await index.search('paint canvas', 3))[0].path).toBe('src/view.ts')
    expect((await index.search('stripe', 3)).find((h) => h.path === 'src/billing.ts')).toBeUndefined()
  })

  it('n’envoie rien au fournisseur tant que l’utilisateur n’a pas activé les embeddings', async () => {
    const p = memoryProject({ ...files })
    const index = new CodebaseIndex(p.deps)
    let calls = 0
    index.setEmbedder((texts) => {
      calls++
      return fakeEmbed(texts)
    }, 'test::m1')
    await index.sync()
    expect(calls).toBe(0)
    expect(index.getStatus().pendingTokens).toBeGreaterThan(0)
    index.setEmbeddingsEnabled(true)
    await index.sync()
    expect(index.getStatus()).toMatchObject({ embedded: 3, embeddingsEnabled: true, embeddingModel: 'test::m1' })
  })

  it('trouve par le sens ce que les mots-clés ne trouvent pas', async () => {
    const p = memoryProject({ ...files })
    const index = new CodebaseIndex(p.deps)
    index.setEmbedder(fakeEmbed, 'test::m1')
    index.setEmbeddingsEnabled(true)
    await index.sync()
    // « connexion » n'apparaît dans aucun fichier : seule la similarité sémantique le relie à auth.ts.
    expect((await index.search('où se passe la connexion ?', 3))[0].path).toBe('src/auth.ts')
    expect((await index.search('facture', 3))[0].path).toBe('src/billing.ts')
  })

  it('recharge l’index enregistré et invalide les vecteurs si le modèle change', async () => {
    const p = memoryProject({ ...files })
    const first = new CodebaseIndex(p.deps)
    first.setEmbedder(fakeEmbed, 'test::m1')
    first.setEmbeddingsEnabled(true)
    await first.sync()
    expect(p.saved()!.chunks.every((c) => c.v)).toBe(true)

    const same = new CodebaseIndex(p.deps)
    same.setEmbedder(fakeEmbed, 'test::m1')
    await same.load()
    expect(same.getStatus()).toMatchObject({ files: 3, embedded: 3, embeddingsEnabled: true })

    const other = new CodebaseIndex(p.deps)
    other.setEmbedder(fakeEmbed, 'test::m2')
    await other.load()
    expect(other.getStatus().embedded).toBe(0)
  })

  it('met à jour un fichier modifié sans tout reparcourir', async () => {
    const p = memoryProject({ ...files })
    const index = new CodebaseIndex(p.deps)
    await index.sync()
    p.touch('src/new.ts', 'export const telemetryEndpoint = "x"')
    await index.update(['src/new.ts'])
    expect((await index.search('telemetryEndpoint', 1))[0].path).toBe('src/new.ts')
  })
})

describe('appels d’embeddings', () => {
  const cfg = (id: string, respond: (url: string, body: any) => unknown, captured: any[]): ProviderConfig => {
    const definition = BUILTIN_PROVIDERS.find((p) => p.id === id)!
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      captured.push({ url, body, headers: init.headers })
      return new Response(JSON.stringify(respond(url, body)), { status: 200 })
    }) as unknown as typeof fetch
    return { definition, apiKey: 'k', baseUrl: definition.defaultBaseUrl, fetch: fetchFn }
  }

  it('format OpenAI / Voyage (avec input_type)', async () => {
    const captured: any[] = []
    const config = cfg('voyage', () => ({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }), captured)
    expect(await embedTexts(config, 'voyage-code-3', ['a', 'b'], 'document')).toEqual([[1], [2]])
    expect(captured[0].url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(captured[0].body).toEqual({ model: 'voyage-code-3', input: ['a', 'b'], input_type: 'document' })
  })

  it('format Gemini', async () => {
    const captured: any[] = []
    const config = cfg('gemini', () => ({ embeddings: [{ values: [0.5] }] }), captured)
    expect(await embedTexts(config, 'gemini-embedding-001', ['q'], 'query')).toEqual([[0.5]])
    expect(captured[0].url).toContain('/models/gemini-embedding-001:batchEmbedContents')
    expect(captured[0].body.requests[0]).toMatchObject({ model: 'models/gemini-embedding-001', taskType: 'RETRIEVAL_QUERY' })
  })

  it('refuse clairement Anthropic, qui n’a pas d’embeddings', async () => {
    const config = cfg('anthropic', () => ({}), [])
    await expect(embedTexts(config, 'x', ['a'], 'query')).rejects.toThrow(/Voyage/)
  })
})
