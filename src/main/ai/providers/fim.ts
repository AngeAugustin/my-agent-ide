import type { ProviderConfig } from './types'
import { errorContext } from './types'
import { errorFromStatus, extractErrorDetail, toAiError } from '../errors'

export interface FimInput {
  model: string
  prefix: string
  suffix: string
  maxTokens: number
}

/**
 * Remplissage « fill-in-the-middle » natif, plus rapide et plus précis qu'une conversation :
 * - Mistral : modèles Codestral via /fim/completions ;
 * - DeepSeek : /beta/completions avec « suffix » ;
 * - Ollama et serveurs compatibles : /completions avec « suffix » (modèles de code).
 * Renvoie null si le fournisseur ou le modèle n'a pas de point d'API FIM connu.
 */
export function fimEndpoint(config: ProviderConfig, model: string): { url: string; kind: 'mistral' | 'openai' } | null {
  const id = config.definition.id
  const base = config.baseUrl.replace(/\/+$/, '')
  if (id === 'mistral' && /codestral/i.test(model)) return { url: `${base}/fim/completions`, kind: 'mistral' }
  if (id === 'deepseek') return { url: `${base.replace(/\/v1$/, '')}/beta/completions`, kind: 'openai' }
  if (id === 'ollama' || id === 'lmstudio') return { url: `${base}/completions`, kind: 'openai' }
  return null
}

export async function fimComplete(config: ProviderConfig, input: FimInput, signal: AbortSignal): Promise<string> {
  const endpoint = fimEndpoint(config, input.model)
  if (!endpoint) throw new Error('FIM indisponible')
  const doFetch = config.fetch ?? fetch
  const body =
    endpoint.kind === 'mistral'
      ? { model: input.model, prompt: input.prefix, suffix: input.suffix, max_tokens: input.maxTokens, temperature: 0 }
      : { model: input.model, prompt: input.prefix, suffix: input.suffix, max_tokens: input.maxTokens, temperature: 0, stream: false }

  let res: Response
  try {
    res = await doFetch(endpoint.url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(body)
    })
  } catch (err) {
    throw toAiError(err, errorContext(config))
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = extractErrorDetail(await res.json())
    } catch {
      // corps non JSON
    }
    throw errorFromStatus(res.status, detail, errorContext(config))
  }
  const json = (await res.json()) as { choices?: Array<{ text?: string; message?: { content?: string } }> }
  const choice = json.choices?.[0]
  return choice?.message?.content ?? choice?.text ?? ''
}
