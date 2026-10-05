import OpenAI from 'openai'
import type { ChatMessage, ContentPart, ModelInfo, StopReason, ToolCall } from '@shared/ai'
import { errorContext, parseToolInput, type ProviderAdapter, type ProviderConfig } from './types'
import { toAiError } from '../errors'

// Modèles qui ne servent pas à la conversation (exclus de la liste proposée).
const NON_CHAT = /(whisper|tts|dall-e|moderation|transcri|davinci|babbage|text-similarity|rerank|image-|sora)/i
const EMBEDDING = /embed/i

function client(config: ProviderConfig): OpenAI {
  return new OpenAI({
    // Les serveurs locaux n'exigent pas de clé, mais le SDK en veut une.
    apiKey: config.apiKey || 'sans-cle',
    baseURL: config.baseUrl,
    maxRetries: 2,
    ...(config.fetch ? { fetch: config.fetch } : {})
  })
}

type OaMessage = Record<string, unknown>

export function toOpenAiMessages(system: string | undefined, messages: ChatMessage[]): OaMessage[] {
  const out: OaMessage[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const parts = m.content
    if (m.role === 'assistant') {
      const text = parts.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('')
      const calls = parts.filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {})
      })
      continue
    }
    // Côté utilisateur : les résultats d'outils deviennent des messages « tool », placés avant le texte.
    for (const p of parts) {
      if (p.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.isError ? `ERREUR : ${p.content}` : p.content })
      }
    }
    const rest = parts.filter((p) => p.type === 'text' || p.type === 'image')
    if (rest.length > 0) {
      out.push({
        role: 'user',
        content: rest.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: `data:${(p as { mediaType: string }).mediaType};base64,${(p as { data: string }).data}` } }
        )
      })
    }
  }
  return out
}

function mapFinish(reason: string | null | undefined, hasTools: boolean): StopReason {
  switch (reason) {
    case 'stop':
      return hasTools ? 'tool_use' : 'end'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return hasTools ? 'tool_use' : reason ? 'other' : 'end'
  }
}

export const openAiAdapter: ProviderAdapter = {
  async listModels(config, signal) {
    if (config.definition.staticModels) return config.definition.staticModels
    const models: ModelInfo[] = []
    try {
      for await (const m of client(config).models.list({ signal })) {
        if (EMBEDDING.test(m.id)) models.push({ id: m.id, kind: 'embedding' })
        else if (!NON_CHAT.test(m.id)) models.push({ id: m.id, kind: 'chat' })
      }
    } catch (err) {
      throw toAiError(err, errorContext(config))
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
  },

  async chat(config, request, ctx) {
    const { emit, signal } = ctx
    const isOpenAi = config.definition.kind === 'openai'
    const params: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true
    }
    if (config.definition.streamUsage) params.stream_options = { include_usage: true }
    if (request.maxTokens) params[isOpenAi ? 'max_completion_tokens' : 'max_tokens'] = request.maxTokens
    if (request.temperature !== undefined) params.temperature = request.temperature
    if (request.effort && isOpenAi) params.reasoning_effort = request.effort === 'xhigh' || request.effort === 'max' ? 'high' : request.effort
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }))
    }

    const pending = new Map<number, { id: string; name: string; args: string }>()
    let text = ''
    let finish: string | null = null
    let inputTokens = 0
    let outputTokens = 0

    try {
      const stream = (await client(config).chat.completions.create(params as never, { signal })) as unknown as AsyncIterable<
        Record<string, any>
      >
      for await (const chunk of stream) {
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens
          outputTokens = chunk.usage.completion_tokens ?? outputTokens
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content
          emit({ type: 'text', text: delta.content })
        }
        // Raisonnement exposé par certains fournisseurs (DeepSeek, OpenRouter, Ollama…).
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning) emit({ type: 'reasoning', text: reasoning })
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0
          const cur = pending.get(index) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          pending.set(index, cur)
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }
    } catch (err) {
      throw toAiError(err, errorContext(config))
    }

    const toolCalls: ToolCall[] = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => {
        const { input, error } = parseToolInput(tc.args)
        return { id: tc.id || `appel_${index}`, name: tc.name, input, ...(error ? { inputError: error } : {}) }
      })
    toolCalls.forEach((call) => emit({ type: 'tool_call', call }))
    emit({ type: 'usage', inputTokens, outputTokens })

    const parts: ContentPart[] = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, input: c.input }))
    ]
    emit({ type: 'done', stopReason: mapFinish(finish, toolCalls.length > 0), toolCalls, message: { role: 'assistant', content: parts } })
  }
}
