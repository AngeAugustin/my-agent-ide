import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalUrl, chunkPage, decodeEntities, docScope, extractLinks, extractTitle, htmlToText, inDocScope, parseDuckDuckGo } from '../src/shared/web'
import { DocsManager } from '../src/main/web/docs'
import { fetchRaw, webSearch } from '../src/main/web/fetcher'

describe('conversion HTML → texte', () => {
  const html = `<!doctype html><html><head><title>Guide &amp; API</title><style>.x{}</style></head>
  <body><nav><a href="/a">Menu</a></nav><main><h1>Installer</h1><p>Lancez la <code>commande</code> suivante&nbsp;:</p>
  <pre><code class="language-bash">npm install &lt;paquet&gt;
  echo  ok</code></pre><ul><li>Un</li><li>Deux</li></ul><script>alert(1)</script></main><footer>pied</footer></body></html>`

  it('garde le contenu principal, les titres, listes et blocs de code', () => {
    const text = htmlToText(html)
    expect(text).toContain('# Installer')
    expect(text).toContain('Lancez la `commande` suivante :')
    expect(text).toContain('```bash\nnpm install <paquet>\n  echo  ok\n```')
    expect(text).toContain('- Un\n- Deux')
    expect(text).not.toMatch(/Menu|pied|alert/)
  })

  it('lit le titre et décode les entités', () => {
    expect(extractTitle(html)).toBe('Guide & API')
    expect(decodeEntities('&#233;t&eacute; &#x41; &inconnu;')).toBe('été A &inconnu;')
  })

  it('extrait les liens absolus sans ancre', () => {
    const links = extractLinks('<a href="b.html#x">b</a><a href=\'/c\'>c</a><a href="mailto:x@y">m</a><a href="#top">t</a>', 'https://ex.com/docs/a.html')
    expect(links).toEqual(['https://ex.com/docs/b.html', 'https://ex.com/c'])
  })

  it('limite l’indexation au dossier de départ', () => {
    const scope = docScope('https://ex.com/docs/intro.html?x=1')
    expect(scope).toBe('https://ex.com/docs/')
    expect(inDocScope('https://ex.com/docs/api/x', scope)).toBe(true)
    expect(inDocScope('https://ex.com/blog/x', scope)).toBe(false)
    expect(inDocScope('https://ex.com/docs/logo.png', scope)).toBe(false)
    expect(canonicalUrl('https://ex.com/docs/index.html#a')).toBe('https://ex.com/docs/')
  })

  it('découpe une page en extraits rattachés à leur titre', () => {
    const text = `# A\n\n${'mot '.repeat(300)}\n\n${'autre '.repeat(300)}\n\n# B\n\ncourt`
    const chunks = chunkPage(text, 1500)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks[1].startsWith('# A')).toBe(true)
    expect(chunks.at(-1)).toBe('# B\n\ncourt')
  })
})

describe('recherche web', () => {
  const ddg = `<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact%2FuseEffect&amp;rut=abc">useEffect &ndash; React</a></h2>
  <a class="result__snippet" href="x">useEffect is a <b>React Hook</b> that lets you</a></div>
  <div class="result"><a class="result__a" href="https://example.org/page">Exemple</a><div class="result__snippet">Deuxième</div></div>`

  it('analyse les résultats de DuckDuckGo', () => {
    expect(parseDuckDuckGo(ddg)).toEqual([
      { title: 'useEffect – React', url: 'https://react.dev/reference/react/useEffect', snippet: 'useEffect is a React Hook that lets you' },
      { title: 'Exemple', url: 'https://example.org/page', snippet: 'Deuxième' }
    ])
  })

  it('interroge Brave et Tavily avec la clé', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('brave')) return Response.json({ web: { results: [{ title: 'T', url: 'https://t', description: '<strong>d</strong>' }] } })
      return Response.json({ results: [{ title: 'U', url: 'https://u', content: 'c' }] })
    }) as typeof fetch
    expect(await webSearch('brave', 'k1', 'q', 3, fake)).toEqual([{ title: 'T', url: 'https://t', snippet: 'd' }])
    expect((calls[0].init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('k1')
    expect(await webSearch('tavily', 'k2', 'q', 3, fake)).toEqual([{ title: 'U', url: 'https://u', snippet: 'c' }])
    await expect(webSearch('brave', null, 'q', 3, fake)).rejects.toThrow(/clé/)
  })

  it('refuse les adresses non http', async () => {
    await expect(fetchRaw('file:///etc/passwd')).rejects.toThrow(/http/)
  })
})

describe('documentations', () => {
  const site: Record<string, string> = {
    'https://docs.ex/guide/': '<title>Accueil</title><main><h1>Accueil</h1><p>Bienvenue.</p><a href="install">Installer</a><a href="/blog/">Blog</a><a href="api/hooks">Hooks</a></main>',
    'https://docs.ex/guide/install': '<title>Installation</title><main><h1>Installation</h1><p>Utilisez npm install monpaquet pour installer.</p><a href="./">retour</a></main>',
    'https://docs.ex/guide/api/hooks': '<title>Hooks</title><main><h1>Hooks</h1><p>La fonction useCompteur renvoie un compteur.</p></main>',
    'https://docs.ex/blog/': '<title>Blog</title><p>hors périmètre</p>'
  }
  const fake = (async (url: string) => {
    const body = site[url]
    if (!body) return new Response('absent', { status: 404 })
    const res = new Response(body, { headers: { 'content-type': 'text/html' } })
    Object.defineProperty(res, 'url', { value: url })
    return res
  }) as typeof fetch

  it('parcourt le site sous le chemin de départ et recherche dans les extraits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-'))
    const statuses: unknown[] = []
    const mgr = new DocsManager(dir, (s) => statuses.push(s), fake)
    const [added] = await mgr.add('Exemple', 'https://docs.ex/guide/', 10)
    for (let i = 0; i < 100 && (await mgr.list())[0].state === 'indexing'; i++) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 50))
    const [status] = await mgr.list()
    expect(status.id).toBe(added.id)
    expect(status.pages).toBe(3)
    expect(status.state).toBe('idle')
    const hits = await mgr.search([], 'installer npm', 3)
    expect(hits[0].url).toBe('https://docs.ex/guide/install')
    expect(hits[0].sourceName).toBe('Exemple')
    // Rechargement depuis le disque
    const again = new DocsManager(dir, () => {}, fake)
    expect((await again.search([added.id], 'useCompteur', 1))[0].title).toBe('Hooks')
    expect(statuses.length).toBeGreaterThan(0)
    await again.remove(added.id)
    expect(await again.list()).toEqual([])
  })
})

import { compactionRequest, contextWindowFor, estimateTokens, shouldCompact, summaryPreamble, transcriptForSummary } from '../src/shared/compaction'
import { toApiMessages, type AgentStep, type HistoryTurn } from '../src/renderer/src/lib/agentHistory'

describe('résumé des conversations', () => {
  const step = (id: string, text: string, tool?: string): AgentStep => ({
    id,
    text,
    reasoning: '',
    tools: tool ? [{ call: { id: `c-${id}`, name: tool, input: { path: 'a.ts' } }, status: 'done', output: 'contenu de a.ts' }] : []
  })
  const turns: HistoryTurn[] = [
    { id: 'u1', role: 'user', sent: 'Question 1', images: [] },
    { id: 'a1', role: 'assistant', text: 'Réponse 1', status: 'done' },
    { id: 'u2', role: 'user', sent: 'Tâche 2', images: [] },
    { id: 'a2', role: 'assistant', text: '', status: 'done', steps: [step('s1', 'Je lis', 'read_file'), step('s2', 'Je modifie', 'edit_file'), step('s3', 'Fini')] },
    { id: 'u3', role: 'user', sent: 'Question 3', images: [] }
  ]

  it('envoie l’historique complet sans résumé', () => {
    const msgs = toApiMessages(turns)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'])
  })

  it('remplace les tours résumés et place le résumé dans le premier message utilisateur', () => {
    const msgs = toApiMessages(turns, { text: 'RÉSUMÉ', turnId: 'a2', stepCount: 3, createdAt: 0, tokensBefore: 10 })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe(`${summaryPreamble('RÉSUMÉ')}\n\nQuestion 3`)
  })

  it('garde les étapes de l’agent postérieures à un résumé fait en cours de tâche', () => {
    const msgs = toApiMessages(turns, { text: 'R', turnId: 'a2', stepCount: 1, createdAt: 0, tokensBefore: 10 })
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(msgs[0].content).toBe(summaryPreamble('R'))
    expect(JSON.stringify(msgs[1].content)).toContain('Je modifie')
  })

  it('termine par le résumé seul quand aucun tour ne suit', () => {
    const msgs = toApiMessages(turns.slice(0, 2), { text: 'R', turnId: 'a1', stepCount: 0, createdAt: 0, tokensBefore: 1 })
    expect(msgs).toEqual([{ role: 'user', content: summaryPreamble('R') }])
  })

  it('transcrit l’historique sans blocs natifs et tronque les longs résultats', () => {
    const msgs = toApiMessages(turns)
    msgs[3] = { ...msgs[3], providerData: { providerId: 'anthropic', model: 'x', raw: [{ type: 'thinking', signature: 'SIG' }] } }
    const long = { role: 'user' as const, content: [{ type: 'tool_result' as const, toolCallId: 'x', toolName: 'read_file', content: 'x'.repeat(10_000) }] }
    const t = transcriptForSummary([...msgs, long])
    expect(t).not.toContain('SIG')
    expect(t).toContain('[appel d’outil read_file] {"path":"a.ts"}')
    expect(t).toContain('caractères omis')
    const req = compactionRequest(msgs)
    expect(req).toHaveLength(1)
    expect(String(req[0].content)).toContain('Prochaines étapes')
  })

  it('décide quand résumer', () => {
    expect(contextWindowFor('claude-opus-5-5')).toBe(200_000)
    expect(contextWindowFor('x', 50_000)).toBe(50_000)
    expect(shouldCompact(170_000, 200_000, 0.8)).toBe(true)
    expect(shouldCompact(150_000, 200_000, 0.8)).toBe(false)
    expect(estimateTokens([{ role: 'user', content: 'abcd'.repeat(100) }])).toBe(100)
  })
})

import { computeHunks, nextEditPrompt, parseNextEdit, pickHunk, recordEdit } from '../src/shared/nextEdit'

describe('prédiction de la prochaine modification', () => {
  const region = ['function total(items) {', '  let somme = 0', '  for (const it of items) somme += it.prix', '  return somme', '}', '', 'console.log(total(liste))']

  it('construit le prompt avec le curseur et les modifications récentes', () => {
    const p = nextEditPrompt({
      path: 'a.js',
      language: 'javascript',
      edits: [{ path: 'a.js', line: 2, before: ['  let total = 0'], after: ['  let somme = 0'], at: 0 }],
      regionLines: region,
      cursor: { line: 1, column: 7 }
    })
    expect(p).toContain('-  let total = 0\n+  let somme = 0')
    expect(p).toContain('  let s<|CURSEUR|>omme = 0')
  })

  it('analyse la réponse du modèle', () => {
    expect(parseNextEdit('<aucune/>')).toBeNull()
    expect(parseNextEdit('bla')).toBeNull()
    expect(parseNextEdit('<region>\n```js\na\nb<|CURSEUR|>\n```\n</region>')).toEqual(['a', 'b'])
  })

  it('isole le changement proposé le plus proche du curseur', () => {
    const proposed = [...region]
    proposed[3] = '  return Math.round(somme)'
    proposed[6] = 'console.log(total(liste), "€")'
    const hunks = computeHunks(region, proposed)
    expect(hunks).toEqual([
      { start: 3, deleteCount: 1, insert: ['  return Math.round(somme)'] },
      { start: 6, deleteCount: 1, insert: ['console.log(total(liste), "€")'] }
    ])
    expect(pickHunk(region, hunks, 1)?.start).toBe(3)
    expect(pickHunk(region, hunks, 6)?.start).toBe(6)
    // Insertion pure
    expect(computeHunks(['a', 'c'], ['a', 'b', 'c'])).toEqual([{ start: 1, deleteCount: 0, insert: ['b'] }])
  })

  it('refuse une réécriture trop large', () => {
    const big = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const rewritten = big.map((l) => `${l}!`)
    expect(pickHunk(big, computeHunks(big, rewritten), 0)).toBeNull()
  })

  it('fusionne la frappe continue sur la même ligne', () => {
    let h = recordEdit([], { path: 'a', line: 2, before: ['let x'], after: ['let xy'], at: 1000 })
    h = recordEdit(h, { path: 'a', line: 2, before: ['let xy'], after: ['let xyz'], at: 1500 })
    expect(h).toEqual([{ path: 'a', line: 2, before: ['let x'], after: ['let xyz'], at: 1500 }])
    h = recordEdit(h, { path: 'a', line: 9, before: ['b'], after: ['c'], at: 1600 })
    expect(h).toHaveLength(2)
    // Retour à l'état initial : la modification disparaît.
    expect(recordEdit([{ path: 'a', line: 1, before: ['a'], after: ['ab'], at: 0 }], { path: 'a', line: 1, before: ['ab'], after: ['a'], at: 100 })).toEqual([])
  })
})
