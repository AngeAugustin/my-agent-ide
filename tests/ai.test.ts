import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDERS, type ChatEvent, type ChatRequest, type ProviderDefinition } from '../src/shared/ai'
import { parseSse } from '../src/main/ai/sse'
import { KeyStore, maskKey, type Encryptor } from '../src/main/ai/keyStore'
import { anthropicAdapter, toAnthropicMessages } from '../src/main/ai/providers/anthropic'
import { openAiAdapter, toOpenAiMessages } from '../src/main/ai/providers/openai'
import { geminiAdapter } from '../src/main/ai/providers/gemini'
import { AiService, type ModelCache, type UsageStats } from '../src/main/ai/service'
import type { ProviderConfig } from '../src/main/ai/providers/types'

// ---------------------------------------------------------------------------
// Outils de test
// ---------------------------------------------------------------------------

function streamOf(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(i, i + chunkSize))
      i += chunkSize
    }
  })
}

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`).join('')
}

interface Captured {
  url: string
  headers: Record<string, string>
  body: any
}

function mockFetch(respond: (url: string) => { status?: number; body: string; contentType?: string }) {
  const calls: Captured[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    calls.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const r = respond(url)
    return new Response(streamOf(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'text/event-stream' }
    })
  }) as typeof fetch
  return { fn, calls }
}

function config(id: string, fetchFn: typeof fetch, apiKey: string | null = 'cle-test'): ProviderConfig {
  const definition = BUILTIN_PROVIDERS.find((p) => p.id === id) as ProviderDefinition
  return { definition, apiKey, baseUrl: definition.defaultBaseUrl, fetch: fetchFn }
}

async function collect(run: (emit: (e: ChatEvent) => void) => Promise<void>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  await run((e) => events.push(e))
  return events
}

const fakeEncryptor: Encryptor = {
  isSecure: () => true,
  backend: () => 'test',
  encrypt: (plain) => Buffer.from(`ENC:${[...plain].reverse().join('')}`),
  decrypt: (data) => [...data.toString().slice(4)].reverse().join('')
}

// ---------------------------------------------------------------------------

describe('parseSse', () => {
  it('reconstitue les événements découpés arbitrairement', async () => {
    const text = 'event: a\ndata: {"x":1}\n\n: commentaire\ndata: ligne1\ndata: ligne2\n\ndata: fin'
    const out = []
    for await (const ev of parseSse(streamOf(text, 3))) out.push(ev)
    expect(out).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'message', data: 'ligne1\nligne2' },
      { event: 'message', data: 'fin' }
    ])
  })
})

describe('stockage des clés', () => {
  it('masque les clés', () => {
    expect(maskKey('sk-ant-api03-abcdefghijklmnop-WXYZ')).toBe('sk-ant…WXYZ')
    expect(maskKey('abc')).toBe('•bc')
  })

  it('chiffre les clés sur le disque et les relit', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ide-keys-')), 'keys.json')
    const store = new KeyStore(file, fakeEncryptor)
    await store.set('anthropic', '  sk-secret-123456  ')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-secret-123456')
    expect(await new KeyStore(file, fakeEncryptor).get('anthropic')).toBe('sk-secret-123456')
    expect((await store.list()).anthropic.secure).toBe(true)
    await store.delete('anthropic')
    expect(await store.get('anthropic')).toBeNull()
  })

  it('signale une clé non protégée quand aucun chiffrement n’est disponible', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ide-keys-')), 'keys.json')
    const broken: Encryptor = { ...fakeEncryptor, isSecure: () => false, encrypt: () => { throw new Error('indisponible') } }
    const store = new KeyStore(file, broken)
    await store.set('openai', 'sk-plain-987654')
    expect(await store.get('openai')).toBe('sk-plain-987654')
    expect((await store.list()).openai.secure).toBe(false)
  })
})

describe('adaptateur Anthropic', () => {
  const request: ChatRequest = {
    providerId: 'anthropic',
    model: 'claude-opus-5-5',
    system: 'Tu es un assistant.',
    messages: [{ role: 'user', content: 'Bonjour' }],
    tools: [{ name: 'lire_fichier', description: 'Lit un fichier', inputSchema: { type: 'object', properties: { chemin: { type: 'string' } } } }]
  }

  const body = sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Je réfléchis' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Je lis ' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'le fichier.' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lire_fichier', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"chemin": "src/' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'a.ts"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ])

  it('diffuse le texte, la réflexion et les appels d’outils', async () => {
    const { fn, calls } = mockFetch(() => ({ body }))
    const events = await collect((emit) => anthropicAdapter.chat(config('anthropic', fn), request, { emit, signal: new AbortController().signal, modelMaxOutput: 128000 }))

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Je lis le fichier.')
    expect(events.some((e) => e.type === 'reasoning')).toBe(true)
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 15, outputTokens: 42 })

    const done = events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>
    expect(done.stopReason).toBe('tool_use')
    expect(done.toolCalls).toEqual([{ id: 'toolu_1', name: 'lire_fichier', input: { chemin: 'src/a.ts' } }])
    // Les blocs natifs (avec la signature de réflexion) sont conservés pour être renvoyés tels quels.
    const raw = done.message.providerData?.raw as Array<Record<string, unknown>>
    expect(raw[0]).toMatchObject({ type: 'thinking', thinking: 'Je réfléchis', signature: 'SIG123' })

    const sent = calls[0]
    expect(sent.url).toContain('/v1/messages')
    expect(sent.headers['x-api-key']).toBe('cle-test')
    expect(sent.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(sent.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 64000, stream: true, system: 'Tu es un assistant.', fallbacks: 'default' })
    expect(sent.body.tools[0]).toMatchObject({ name: 'lire_fichier', eager_input_streaming: true })
    expect(sent.body.temperature).toBeUndefined()
  })

  it('n’active pas le repli serveur pour les autres modèles', async () => {
    const { fn, calls } = mockFetch(() => ({ body }))
    await collect((emit) => anthropicAdapter.chat(config('anthropic', fn), { ...request, model: 'claude-haiku-4-5' }, { emit, signal: new AbortController().signal }))
    expect(calls[0].body.fallbacks).toBeUndefined()
    expect(calls[0].body.max_tokens).toBe(16000)
  })

  it('signale des arguments d’outil invalides sans lever', async () => {
    const broken = body.replace('a.ts\\"}', 'a.ts')
    const { fn } = mockFetch(() => ({ body: broken }))
    const events = await collect((emit) => anthropicAdapter.chat(config('anthropic', fn), request, { emit, signal: new AbortController().signal }))
    const done = events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>
    expect(done.toolCalls[0].inputError).toBe('{"chemin": "src/a.ts')
  })

  it('traduit une clé refusée en erreur explicite', async () => {
    const { fn } = mockFetch(() => ({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    }))
    await expect(
      anthropicAdapter.chat(config('anthropic', fn), request, { emit: () => {}, signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'auth', message: expect.stringContaining('Clé API refusée par Anthropic') })
  })

  it('renvoie le contenu natif de l’assistant au même fournisseur', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'S' }, { type: 'text', text: 'ok' }]
    const out = toAnthropicMessages(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'ok', providerData: { providerId: 'anthropic', model: 'm', raw } },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', toolName: 'x', content: 'résultat', isError: true }] }
      ],
      'anthropic'
    )
    expect(out[1].content).toBe(raw)
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'résultat', is_error: true }])
  })
})

describe('adaptateur compatible OpenAI', () => {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Bon' } }] },
    { choices: [{ index: 0, delta: { content: 'jour' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'chercher', arguments: '{"q":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }
  ]
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

  it('diffuse le texte et assemble les appels d’outils fragmentés', async () => {
    const { fn, calls } = mockFetch(() => ({ body }))
    const events = await collect((emit) =>
      openAiAdapter.chat(
        config('openai', fn),
        { providerId: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'Salut' }], maxTokens: 500, tools: [{ name: 'chercher', description: 'd', inputSchema: { type: 'object' } }] },
        { emit, signal: new AbortController().signal }
      )
    )
    const done = events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>
    expect(done.stopReason).toBe('tool_use')
    expect(done.toolCalls).toEqual([{ id: 'call_1', name: 'chercher', input: { q: 'test' } }])
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 20, outputTokens: 8 })
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0].headers.authorization).toBe('Bearer cle-test')
    expect(calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_completion_tokens: 500 })
  })

  it('utilise max_tokens et aucune clé pour un serveur local', async () => {
    const { fn, calls } = mockFetch(() => ({ body: 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' }))
    const events = await collect((emit) =>
      openAiAdapter.chat(config('lmstudio', fn, null), { providerId: 'lmstudio', model: 'qwen', messages: [{ role: 'user', content: 'x' }], maxTokens: 50 }, { emit, signal: new AbortController().signal })
    )
    expect(calls[0].url).toBe('http://localhost:1234/v1/chat/completions')
    expect(calls[0].body.max_tokens).toBe(50)
    expect(calls[0].body.stream_options).toBeUndefined()
    expect((events.find((e) => e.type === 'done') as { stopReason: string }).stopReason).toBe('end')
  })

  it('convertit les résultats d’outils en messages « tool »', () => {
    const out = toOpenAiMessages('sys', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'f', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', toolName: 'f', content: 'ok' }, { type: 'text', text: 'suite' }] }
    ])
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'suite' }] }
    ])
  })

  it('filtre les modèles qui ne servent pas à la conversation', async () => {
    const { fn } = mockFetch(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ object: 'list', data: [{ id: 'gpt-b' }, { id: 'text-embedding-3-small' }, { id: 'gpt-a' }, { id: 'whisper-1' }] })
    }))
    expect((await openAiAdapter.listModels(config('openai', fn))).map((m) => `${m.id}:${m.kind}`)).toEqual(['gpt-a:chat', 'gpt-b:chat', 'text-embedding-3-small:embedding'])
  })
})

describe('adaptateur Gemini', () => {
  it('diffuse texte, réflexion et appels de fonctions en conservant les parties natives', async () => {
    const body = sse([
      { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Analyse', thought: true }] } }] } },
      { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Voici ' }] } }] } },
      { data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'lister', args: { dossier: 'src' } }, thoughtSignature: 'abc' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, thoughtsTokenCount: 4 } } }
    ])
    const { fn, calls } = mockFetch(() => ({ body }))
    const events = await collect((emit) =>
      geminiAdapter.chat(
        config('gemini', fn),
        { providerId: 'gemini', model: 'gemini-test', system: 'sys', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'lister', description: 'd', inputSchema: { type: 'object' } }] },
        { emit, signal: new AbortController().signal }
      )
    )
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse')
    expect(calls[0].headers['x-goog-api-key']).toBe('cle-test')
    expect(calls[0].body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] })
    expect(calls[0].body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual({ type: 'object' })

    const done = events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>
    expect(done.stopReason).toBe('tool_use')
    expect(done.toolCalls[0]).toMatchObject({ name: 'lister', input: { dossier: 'src' } })
    expect((done.message.providerData?.raw as unknown[])[2]).toMatchObject({ thoughtSignature: 'abc' })
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 12, outputTokens: 10 })
  })
})

describe('AiService', () => {
  function memory<T>(initial: T) {
    let value = initial
    return { get: async () => value, set: async (v: T) => void (value = v) }
  }

  function service(fetchFn: typeof fetch, keys: KeyStore) {
    const usage = memory<UsageStats>({})
    const svc = new AiService({
      keys,
      getSettings: async () => ({ providers: { ollama: { baseUrl: 'http://127.0.0.1:9999/v1/' } }, customProviders: [], models: {} }),
      modelCache: memory<ModelCache>({}),
      usage,
      storageInfo: () => ({ encrypted: true, backend: 'test' }),
      fetch: fetchFn
    })
    return { svc, usage }
  }

  it('émet une erreur claire quand la clé manque', async () => {
    const keys = new KeyStore(join(mkdtempSync(join(tmpdir(), 'ide-svc-')), 'k.json'), fakeEncryptor)
    const { svc } = service(mockFetch(() => ({ body: '' })).fn, keys)
    const events = await collect((emit) => svc.chat({ providerId: 'anthropic', model: 'x', messages: [] }, emit, new AbortController().signal))
    expect(events).toEqual([{ type: 'error', code: 'no_key', message: expect.stringContaining('Aucune clé API') }])
  })

  it('applique l’URL personnalisée et comptabilise la consommation', async () => {
    const keys = new KeyStore(join(mkdtempSync(join(tmpdir(), 'ide-svc-')), 'k.json'), fakeEncryptor)
    const { fn, calls } = mockFetch(() => ({
      body: 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
    }))
    const { svc, usage } = service(fn, keys)
    const events = await collect((emit) => svc.chat({ providerId: 'ollama', model: 'llama', messages: [{ role: 'user', content: 'x' }] }, emit, new AbortController().signal))
    expect(calls[0].url).toBe('http://127.0.0.1:9999/v1/chat/completions')
    expect(events.at(-1)?.type).toBe('done')
    expect((await usage.get()).ollama).toMatchObject({ requests: 1, inputTokens: 3, outputTokens: 2 })
  })

  it('n’expose jamais la clé complète dans les statuts', async () => {
    const keys = new KeyStore(join(mkdtempSync(join(tmpdir(), 'ide-svc-')), 'k.json'), fakeEncryptor)
    await keys.set('openai', 'sk-proj-tres-secrete-1234')
    const { svc } = service(mockFetch(() => ({ body: '' })).fn, keys)
    const { providers } = await svc.statuses()
    expect(JSON.stringify(providers)).not.toContain('tres-secrete')
    expect(providers.find((p) => p.id === 'openai')).toMatchObject({ hasKey: true, maskedKey: 'sk-pro…1234' })
  })
})
