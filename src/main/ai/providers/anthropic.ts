import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ContentPart, ModelInfo, StopReason, ToolCall } from '@shared/ai'
import { errorContext, parseToolInput, type ProviderAdapter, type ProviderConfig } from './types'
import { toAiError } from '../errors'

/**
 * Modèles pour lesquels on active le repli côté serveur : si le classifieur de sécurité
 * décline une demande, l'API la relance automatiquement sur un modèle de secours adapté.
 */
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const DEFAULT_MAX_TOKENS = 64000
/** Modèles qui acceptent la réflexion adaptative et le paramètre « effort ». */
const ADAPTIVE_MODELS = /^claude-(opus-4-[6-9]|sonnet-4-[6-9]|opus-5|sonnet-5|fable|mythos)/

export function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_MODELS.test(model)
}
const UNKNOWN_MODEL_MAX_TOKENS = 16000

function client(config: ProviderConfig): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey ?? '',
    baseURL: config.baseUrl,
    maxRetries: 2,
    ...(config.fetch ? { fetch: config.fetch } : {})
  })
}

function isDefaultEndpoint(config: ProviderConfig): boolean {
  return config.baseUrl.replace(/\/+$/, '') === config.definition.defaultBaseUrl
}

type Block = Record<string, unknown> & { type: string }

function toAnthropicContent(parts: ContentPart[]): Block[] {
  return parts.map((p): Block => {
    switch (p.type) {
      case 'text':
        return { type: 'text', text: p.text }
      case 'image':
        return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
      case 'tool_call':
        return { type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} }
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, ...(p.isError ? { is_error: true } : {}) }
    }
  })
}

export function toAnthropicMessages(messages: ChatMessage[], providerId: string): Array<{ role: 'user' | 'assistant'; content: string | Block[] }> {
  return messages.map((m) => {
    // Renvoie le contenu natif (blocs de réflexion signés, blocs de repli…) inchangé.
    if (m.role === 'assistant' && m.providerData?.providerId === providerId && Array.isArray(m.providerData.raw)) {
      return { role: m.role, content: m.providerData.raw as Block[] }
    }
    return { role: m.role, content: typeof m.content === 'string' ? m.content : toAnthropicContent(m.content) }
  })
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end'
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

export const anthropicAdapter: ProviderAdapter = {
  async listModels(config, signal) {
    const models: ModelInfo[] = []
    try {
      for await (const m of client(config).models.list({ limit: 100 }, { signal })) {
        const info = m as typeof m & { max_input_tokens?: number; max_tokens?: number }
        models.push({ id: m.id, name: m.display_name, contextWindow: info.max_input_tokens, maxOutput: info.max_tokens })
      }
    } catch (err) {
      throw toAiError(err, errorContext(config))
    }
    return models
  },

  async chat(config, request, ctx) {
    const { emit, signal } = ctx
    const useFallback = SERVER_FALLBACK_MODELS.has(request.model) && isDefaultEndpoint(config)
    const maxTokens =
      request.maxTokens ?? (ctx.modelMaxOutput ? Math.min(ctx.modelMaxOutput, DEFAULT_MAX_TOKENS) : UNKNOWN_MODEL_MAX_TOKENS)

    const params: Record<string, unknown> = {
      model: request.model,
      max_tokens: maxTokens,
      messages: toAnthropicMessages(request.messages, config.definition.id),
      stream: true
    }
    if (request.system) params.system = request.system
    if (request.temperature !== undefined) params.temperature = request.temperature
    const adaptive = supportsAdaptiveThinking(request.model)
    if (request.effort && adaptive) params.output_config = { effort: request.effort }
    // Par défaut, la réflexion de ces modèles n'est pas renvoyée (« omitted ») : on demande un résumé lisible.
    if (request.showReasoning && adaptive) params.thinking = { type: 'adaptive', display: 'summarized' }
    if (request.tools?.length) {
      // Diffusion immédiate des arguments d'outils ; ils sont validés strictement à la fin de chaque bloc.
      params.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        eager_input_streaming: true
      }))
    }
    if (useFallback) {
      params.betas = [FALLBACK_BETA]
      params.fallbacks = 'default'
    }

    const blocks: Block[] = []
    const partialJson = new Map<number, string>()
    const toolCalls: ToolCall[] = []
    let inputTokens = 0
    let outputTokens = 0
    let stopReason: StopReason = 'other'

    try {
      const stream = (await client(config).beta.messages.create(params as never, { signal })) as unknown as AsyncIterable<
        Record<string, any>
      >
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message?.usage ?? {}
            inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            outputTokens = u.output_tokens ?? 0
            break
          }
          case 'content_block_start': {
            const block = structuredClone(event.content_block) as Block
            blocks[event.index] = block
            if (block.type === 'tool_use') partialJson.set(event.index, '')
            if (block.type === 'fallback') {
              const from = (block.from as { model?: string } | undefined)?.model ?? 'le modèle'
              const to = (block.to as { model?: string } | undefined)?.model ?? 'un modèle de secours'
              emit({ type: 'notice', message: `${from} a décliné la demande ; ${to} a pris le relais.` })
            }
            break
          }
          case 'content_block_delta': {
            const block = blocks[event.index]
            const delta = event.delta
            if (!block) break
            if (delta.type === 'text_delta') {
              block.text = ((block.text as string) ?? '') + delta.text
              emit({ type: 'text', text: delta.text })
            } else if (delta.type === 'thinking_delta') {
              block.thinking = ((block.thinking as string) ?? '') + delta.thinking
              if (delta.thinking) emit({ type: 'reasoning', text: delta.thinking })
            } else if (delta.type === 'signature_delta') {
              block.signature = delta.signature
            } else if (delta.type === 'input_json_delta') {
              partialJson.set(event.index, (partialJson.get(event.index) ?? '') + delta.partial_json)
            } else if (delta.type === 'citations_delta') {
              block.citations = [...((block.citations as unknown[]) ?? []), delta.citation]
            }
            break
          }
          case 'content_block_stop': {
            const block = blocks[event.index]
            if (block?.type === 'tool_use') {
              const { input, error } = parseToolInput(partialJson.get(event.index) ?? '')
              block.input = input
              const call: ToolCall = { id: block.id as string, name: block.name as string, input, ...(error ? { inputError: error } : {}) }
              toolCalls.push(call)
              emit({ type: 'tool_call', call })
            }
            break
          }
          case 'message_delta': {
            if (event.delta?.stop_reason) stopReason = mapStopReason(event.delta.stop_reason)
            if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens
            break
          }
        }
      }
    } catch (err) {
      throw toAiError(err, errorContext(config))
    }

    emit({ type: 'usage', inputTokens, outputTokens })
    const content = blocks.filter(Boolean)
    const text = content.filter((b) => b.type === 'text').map((b) => b.text as string).join('')
    const parts: ContentPart[] = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, input: c.input }))
    ]
    emit({
      type: 'done',
      stopReason,
      toolCalls,
      message: { role: 'assistant', content: parts, providerData: { providerId: config.definition.id, model: request.model, raw: content } }
    })
  }
}
