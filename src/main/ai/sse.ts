export interface SseEvent {
  event: string
  data: string
}

/** Lit un flux Server-Sent Events et renvoie chaque événement complet. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []

  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      event = ''
      return null
    }
    const out = { event: event || 'message', data: data.join('\n') }
    event = ''
    data = []
    return out
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let idx: number
      while ((idx = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1))
        if (line === '') {
          const ev = flush()
          if (ev) yield ev
        } else if (line.startsWith(':')) {
          // Commentaire (maintien de connexion).
        } else {
          const colon = line.indexOf(':')
          const field = colon >= 0 ? line.slice(0, colon) : line
          let value = colon >= 0 ? line.slice(colon + 1) : ''
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
      }
      if (done) break
    }
    if (buffer) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart())
    }
    const last = flush()
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}
