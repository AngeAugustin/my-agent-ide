import { describe, expect, it } from 'vitest'
import { canCompleteBefore, cleanCompletion, completionUserPrompt, CURSOR_MARKER, lookupCompletionCache } from '../src/shared/completion'
import { AiService } from '../src/main/ai/service'
import { KeyStore } from '../src/main/ai/keyStore'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fimComplete, fimEndpoint } from '../src/main/ai/providers/fim'
import { BUILTIN_PROVIDERS } from '../src/shared/ai'
import type { ProviderConfig } from '../src/main/ai/providers/types'

describe('cleanCompletion', () => {
  it('retire les blocs Markdown et le marqueur de curseur', () => {
    expect(cleanCompletion('```ts\nreturn a + b\n```', 'function f() {\n  ', '\n}')).toBe('return a + b')
    expect(cleanCompletion(`x${CURSOR_MARKER}`, 'const a = ', '')).toBe('x')
  })

  it('retire la répétition de la ligne en cours', () => {
    expect(cleanCompletion('console.log(total)', '  const t = 1\n  console.lo', '')).toBe('g(total)')
  })

  it('ne coupe pas une vraie suite courte', () => {
    expect(cleanCompletion('a + b', 'const x = a', '')).toBe('a + b')
  })

  it('retire les fermetures déjà présentes après le curseur', () => {
    expect(cleanCompletion("'monde')", "console.log(", ')')).toBe("'monde'")
  })

  it('ne répète pas les lignes qui suivent le curseur', () => {
    const suffix = '\n}\n\nexport default f'
    expect(cleanCompletion('const y = 2\n  return y\n}\n\nexport default f', 'function f() {\n  ', suffix)).toBe('const y = 2\n  return y')
  })

  it('renvoie une chaîne vide si rien d’utile', () => {
    expect(cleanCompletion('   \n ', 'a', '')).toBe('')
  })

  it('limite la longueur', () => {
    const long = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')
    expect(cleanCompletion(long, 'x\n', '').split('\n')).toHaveLength(30)
  })
})

describe('règles de déclenchement', () => {
  it('complète en fin de ligne ou avant des fermetures uniquement', () => {
    expect(canCompleteBefore('')).toBe(true)
    expect(canCompleteBefore(')]; ')).toBe(true)
    expect(canCompleteBefore('foo)')).toBe(false)
  })

  it('place le marqueur au curseur', () => {
    expect(completionUserPrompt({ path: 'a.ts', language: 'typescript', prefix: 'const a = ', suffix: '\n' })).toContain(`const a = ${CURSOR_MARKER}\n`)
  })

  it('réutilise une suggestion dont l’utilisateur tape le début', () => {
    const entries = [{ prefix: 'const a = ', suffix: '', text: 'compute(1, 2)' }]
    expect(lookupCompletionCache('const a = comp', '', entries)).toBe('ute(1, 2)')
    expect(lookupCompletionCache('const a = x', '', entries)).toBeNull()
    expect(lookupCompletionCache('const a = compute(1, 2)', '', entries)).toBeNull()
  })

  it('tient compte de la parenthèse fermée automatiquement par l’éditeur', () => {
    const entries = [{ prefix: 'const a = ', suffix: '\nfin', text: 'compute(1, 2) + 3' }]
    expect(lookupCompletionCache('const a = compute(', ')\nfin', entries)).toBe('1, 2')
  })
})

describe('FIM natif', () => {
  const cfg = (id: string, fetchFn?: typeof fetch): ProviderConfig => {
    const definition = BUILTIN_PROVIDERS.find((p) => p.id === id)!
    return { definition, apiKey: 'k', baseUrl: definition.defaultBaseUrl, fetch: fetchFn }
  }

  it('choisit le bon point d’API selon le fournisseur', () => {
    expect(fimEndpoint(cfg('mistral'), 'codestral-latest')?.url).toBe('https://api.mistral.ai/v1/fim/completions')
    expect(fimEndpoint(cfg('mistral'), 'mistral-large-latest')).toBeNull()
    expect(fimEndpoint(cfg('deepseek'), 'deepseek-chat')?.url).toBe('https://api.deepseek.com/beta/completions')
    expect(fimEndpoint(cfg('ollama'), 'qwen2.5-coder')?.url).toBe('http://localhost:11434/v1/completions')
    expect(fimEndpoint(cfg('anthropic'), 'claude-haiku-4-5')).toBeNull()
  })

  it('envoie préfixe et suffixe, et lit la réponse', async () => {
    let sent: any
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'b + c' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const text = await fimComplete(cfg('mistral', fetchFn), { model: 'codestral-latest', prefix: 'a = ', suffix: '\n', maxTokens: 64 }, new AbortController().signal)
    expect(text).toBe('b + c')
    expect(sent).toMatchObject({ model: 'codestral-latest', prompt: 'a = ', suffix: '\n', max_tokens: 64 })
  })

  it('remonte une erreur 400 (modèle sans FIM)', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: 'suffix not supported' } }), { status: 400 })) as unknown as typeof fetch
    await expect(fimComplete(cfg('ollama', fetchFn), { model: 'llama3', prefix: 'a', suffix: '', maxTokens: 8 }, new AbortController().signal)).rejects.toMatchObject({
      code: 'bad_request'
    })
  })
})

describe('AiService.complete', () => {
  it('bascule sur la conversation quand le modèle ne gère pas le FIM, puis s’en souvient', async () => {
    const urls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      urls.push(url)
      if (url.endsWith('/completions') && !url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ error: { message: 'model does not support insert' } }), { status: 400 })
      }
      const body = 'data: {"choices":[{"index":0,"delta":{"content":"(1, 2)"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const mem = <T>(v: T) => ({ get: async () => v, set: async (n: T) => void (v = n) })
    const svc = new AiService({
      keys: new KeyStore(join(mkdtempSync(join(tmpdir(), 'ide-cmp-')), 'k.json'), { isSecure: () => true, backend: () => 't', encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }),
      getSettings: async () => ({ providers: {}, customProviders: [], models: {} }),
      modelCache: mem({}),
      usage: mem({}),
      storageInfo: () => ({ encrypted: true, backend: 't' }),
      fetch: fetchFn
    })
    const req = { providerId: 'ollama', model: 'llama3', path: 'a.ts', language: 'typescript', prefix: 'add', suffix: '' }
    const first = await svc.complete(req, new AbortController().signal)
    expect(first).toEqual({ text: '(1, 2)', via: 'chat' })
    expect(urls).toEqual(['http://localhost:11434/v1/completions', 'http://localhost:11434/v1/chat/completions'])
    await svc.complete(req, new AbortController().signal)
    expect(urls.slice(2)).toEqual(['http://localhost:11434/v1/chat/completions'])
  })
})
