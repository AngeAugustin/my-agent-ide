import type { ChatMessage, ContentPart, ModelInfo, StopReason, ToolCall } from '@shared/ai'
import { errorContext, type ProviderAdapter, type ProviderConfig } from './types'
import { errorFromStatus, extractErrorDetail, toAiError, AiError } from '../errors'
import { parseSse } from '../sse'

type Part = Record<string, unknown>
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

function base(config: ProviderConfig): string {
  return config.baseUrl.replace(/\/+$/, '')
}

async function request(config: ProviderConfig, path: string, init: RequestInit): Promise<Response> {
  const doFetch = config.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${base(config)}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey ?? '', ...(init.headers ?? {}) }
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
  return res
}

export function toGeminiContents(messages: ChatMessage[], providerId: string): Content[] {
  // Les réponses de fonctions doivent porter le nom de la fonction appelée.
  return messages.map((m): Content => {
    const role = m.role === 'assistant' ? 'model' : 'user'
    // Renvoie les parties natives (avec leurs « thoughtSignature ») au même fournisseur.
    if (m.role === 'assistant' && m.providerData?.providerId === providerId && Array.isArray(m.providerData.raw)) {
      return { role, parts: m.providerData.raw as Part[] }
    }
    if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] }
    return {
      role,
      parts: m.content.map((p: ContentPart): Part => {
        switch (p.type) {
          case 'text':
            return { text: p.text }
          case 'image':
            return { inlineData: { mimeType: p.mediaType, data: p.data } }
          case 'tool_call':
            return { functionCall: { name: p.name, args: p.input ?? {}, id: p.id } }
          case 'tool_result':
            return {
              functionResponse: {
                name: p.toolName,
                id: p.toolCallId,
                response: p.isError ? { error: p.content } : { content: p.content }
              }
            }
        }
      })
    }
  })
}

function mapFinish(reason: string | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'tool_use'
  switch (reason) {
    case 'STOP':
    case undefined:
      return 'end'
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'refusal'
    default:
      return 'other'
  }
}

export const geminiAdapter: ProviderAdapter = {
  async listModels(config, signal) {
    const models: ModelInfo[] = []
    let pageToken = ''
    do {
      const res = await request(config, `/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, {
        method: 'GET',
        signal
      })
      const body = (await res.json()) as {
        models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }>
        nextPageToken?: string
      }
      for (const m of body.models ?? []) {
        if (!m.supportedGenerationMethods?.includes('generateContent')) continue
        models.push({
          id: m.name.replace(/^models\//, ''),
          name: m.displayName,
          contextWindow: m.inputTokenLimit,
          maxOutput: m.outputTokenLimit
        })
      }
      pageToken = body.nextPageToken ?? ''
    } while (pageToken)
    return models
  },

  async chat(config, req, ctx) {
    const { emit, signal } = ctx
    const body: Record<string, unknown> = { contents: toGeminiContents(req.messages, config.definition.id) }
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
    const generationConfig: Record<string, unknown> = {}
    if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema }))
        }
      ]
    }

    const res = await request(config, `/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal
    })

    const rawParts: Part[] = []
    const toolCalls: ToolCall[] = []
    let text = ''
    let finish: string | undefined
    let inputTokens = 0
    let outputTokens = 0

    try {
      for await (const ev of parseSse(res.body!)) {
        let chunk: Record<string, any>
        try {
          chunk = JSON.parse(ev.data)
        } catch {
          continue
        }
        if (chunk.error) throw new AiError('server', `${config.definition.name} : ${extractErrorDetail(chunk)}`)
        if (chunk.promptFeedback?.blockReason) {
          finish = 'SAFETY'
        }
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens
          outputTokens = (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0)
        }
        const candidate = chunk.candidates?.[0]
        if (!candidate) continue
        for (const part of (candidate.content?.parts ?? []) as Part[]) {
          rawParts.push(part)
          if (typeof part.text === 'string') {
            if (part.thought) emit({ type: 'reasoning', text: part.text })
            else {
              text += part.text
              emit({ type: 'text', text: part.text })
            }
          } else if (part.functionCall) {
            const fc = part.functionCall as { name: string; args?: unknown; id?: string }
            const call: ToolCall = { id: fc.id ?? `appel_${toolCalls.length}`, name: fc.name, input: fc.args ?? {} }
            toolCalls.push(call)
            emit({ type: 'tool_call', call })
          }
        }
        if (candidate.finishReason) finish = candidate.finishReason
      }
    } catch (err) {
      throw toAiError(err, errorContext(config))
    }

    emit({ type: 'usage', inputTokens, outputTokens })
    const parts: ContentPart[] = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, input: c.input }))
    ]
    emit({
      type: 'done',
      stopReason: mapFinish(finish, toolCalls.length > 0),
      toolCalls,
      message: { role: 'assistant', content: parts, providerData: { providerId: config.definition.id, model: req.model, raw: rawParts } }
    })
  }
}
