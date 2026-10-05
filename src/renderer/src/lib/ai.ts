import type { ChatEvent, ChatRequest, ToolCall, StopReason, ChatMessage } from '@shared/ai'

type Listener = (event: ChatEvent) => void
const listeners = new Map<string, Listener>()
let subscribed = false
let counter = 0

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.api.ai.onEvent((requestId, event) => listeners.get(requestId)?.(event))
}

export type ChatOutcome =
  | { ok: true; stopReason: StopReason; message: ChatMessage; toolCalls: ToolCall[]; text: string; inputTokens: number; outputTokens: number }
  | { ok: false; code: string; message: string; text: string }

export interface ChatHandle {
  requestId: string
  abort(): void
  result: Promise<ChatOutcome>
}

/** Lance une requête de conversation en flux ; `onEvent` reçoit chaque événement. */
export function streamChat(request: ChatRequest, onEvent?: Listener): ChatHandle {
  ensureSubscribed()
  const requestId = `req-${Date.now()}-${++counter}`
  let text = ''
  let usage = { inputTokens: 0, outputTokens: 0 }

  const result = new Promise<ChatOutcome>((resolve) => {
    listeners.set(requestId, (event) => {
      onEvent?.(event)
      if (event.type === 'text') text += event.text
      else if (event.type === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
      else if (event.type === 'done') {
        listeners.delete(requestId)
        resolve({ ok: true, stopReason: event.stopReason, message: event.message, toolCalls: event.toolCalls, text, ...usage })
      } else if (event.type === 'error') {
        listeners.delete(requestId)
        resolve({ ok: false, code: event.code, message: event.message, text })
      }
    })
    window.api.ai.chat(requestId, request).catch((err: unknown) => {
      listeners.delete(requestId)
      resolve({ ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err), text })
    })
  })

  return { requestId, abort: () => window.api.ai.abort(requestId), result }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.', ',')} k`
  return String(n)
}
