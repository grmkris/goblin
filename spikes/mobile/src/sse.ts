export type SseFrame = { readonly event: string; readonly data: string }
const MAX_FRAME = 4 * 1024 * 1024

/** Line-oriented parsing preserves CRLF across chunks and removes exactly one optional space after the colon. */
export class SseDecoder {
  #line = ''
  #event = 'message'
  #data: string[] = []
  #size = 0
  #skipLf = false
  push(chunk: string): SseFrame[] {
    const frames: SseFrame[] = []
    for (const char of chunk) {
      if (this.#skipLf && char === '\n') {
        this.#skipLf = false
        continue
      }
      this.#skipLf = char === '\r'
      if (char === '\r' || char === '\n') {
        const frame = this.#consumeLine()
        if (frame !== undefined) frames.push(frame)
      } else {
        this.#line += char
        this.#size += 1
        if (this.#size > MAX_FRAME) throw new Error('Event stream frame exceeds the mobile limit.')
      }
    }
    return frames
  }
  #consumeLine(): SseFrame | undefined {
    const line = this.#line
    this.#line = ''
    if (line === '') {
      const frame = this.#data.length === 0 ? undefined : { event: this.#event, data: this.#data.join('\n') }
      this.#data = []
      this.#event = 'message'
      this.#size = 0
      return frame
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const raw = colon < 0 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'event') this.#event = value || 'message'
    if (field === 'data') this.#data.push(value)
    return undefined
  }
}

export async function readSse(
  response: Response,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  if (
    !response.ok ||
    !response.headers.get('content-type')?.startsWith('text/event-stream') ||
    response.body === null
  ) {
    throw new Error('Goblin did not return an event stream.')
  }
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => {
      /* expected: an already failed stream needs no cancellation. */
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new SseDecoder()
  try {
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done || signal.aborted) return
      for (const frame of parser.push(decoder.decode(next.value, { stream: true }))) onFrame(frame)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {
      /* expected: the transport may already be aborted. */
    })
    reader.releaseLock()
  }
}
