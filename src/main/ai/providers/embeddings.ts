import type { ProviderConfig } from './types'
import { errorContext } from './types'
import { AiError, errorFromStatus, extractErrorDetail, toAiError } from '../errors'

export type EmbeddingInput = 'document' | 'query'

async function post(config: ProviderConfig, url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const doFetch = config.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
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
  return res.json()
}

/** Calcule les vecteurs d'une liste de textes (un vecteur par texte, dans le même ordre). */
export async function embedTexts(
  config: ProviderConfig,
  model: string,
  texts: string[],
  inputType: EmbeddingInput,
  signal?: AbortSignal
): Promise<number[][]> {
  if (texts.length === 0) return []
  const base = config.baseUrl.replace(/\/+$/, '')
  switch (config.definition.kind) {
    case 'anthropic':
      throw new AiError(
        'bad_request',
        'Anthropic ne propose pas de modèle d’embeddings. Utilisez Voyage AI (recommandé par Anthropic), OpenAI, Gemini, Mistral ou un modèle local.'
      )
    case 'gemini': {
      const json = await post(
        config,
        `${base}/models/${encodeURIComponent(model)}:batchEmbedContents`,
        {
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'
          }))
        },
        { 'x-goog-api-key': config.apiKey ?? '' },
        signal
      )
      return (json.embeddings ?? []).map((e: { values: number[] }) => e.values)
    }
    default: {
      const body: Record<string, unknown> = { model, input: texts }
      // Voyage distingue les documents indexés des requêtes de recherche.
      if (config.definition.id === 'voyage') body.input_type = inputType
      const json = await post(config, `${base}/embeddings`, body, config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, signal)
      const data = (json.data ?? []) as Array<{ embedding: number[]; index?: number }>
      return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
    }
  }
}
