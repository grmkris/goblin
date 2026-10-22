// A chat's stream served in memory, as the agent serves `GET /api/conversations/:id/stream`: each connection opens
// with what `opening` holds then (the chat as it is), then gets every event the test writes, as server-sent events.
// The test drops connections as the network does, ends them as the server does, or refuses new ones.
import type { StreamDependencies } from '../src/lib/agui/reader.ts'
import { readEvents } from '../src/lib/event-streams.ts'
import type { ReconnectScheduler } from '../src/lib/reconnect.ts'

/** Timers that run only when the test says so. */
export class Clock implements ReconnectScheduler {
  now = 0
  readonly #timers = new Set<{ at: number; run: () => void }>()
  schedule = (run: () => void, delayMs: number) => {
    const timer = { at: this.now + delayMs, run }
    this.#timers.add(timer)
    return () => void this.#timers.delete(timer)
  }
  advance(ms: number): void {
    this.now += ms
    for (const timer of [...this.#timers].filter(({ at }) => at <= this.now)) {
      this.#timers.delete(timer)
      timer.run()
    }
  }
}

/** One connection the server holds open: whether it is closed, by either side. */
export type Held = { readonly controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }

const encoder = new TextEncoder()
/** `events` as the server frames them: one `data:` frame each. */
export const framesOf = (events: readonly unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')

export class FakeStream {
  /** What a new connection opens with: the chat's snapshots, as the server would make them now. */
  opening: unknown[] = []
  /** Every connection made, in order. */
  readonly connections: Held[] = []
  /** Answered instead of a stream while set: a refusal with that status, or a failure to reach the server. */
  refuse: number | 'network' | undefined

  /** The connections still open. */
  get open(): Held[] {
    return this.connections.filter(({ closed }) => !closed)
  }

  /** Sends `text` as it is on every open connection. */
  send(text: string): void {
    for (const held of this.open) held.controller.enqueue(encoder.encode(text))
  }

  /** Sends `events` on every open connection, and keeps them in what the next opening holds. */
  write(...events: unknown[]): void {
    this.opening.push(...events)
    this.send(framesOf(events))
  }

  /** Every open connection fails, as when the network drops. */
  drop(): void {
    for (const held of this.open) {
      held.closed = true
      held.controller.error(new TypeError('network error'))
    }
  }

  /** The server ends every open connection cleanly (its life is over, or it fell behind). */
  end(): void {
    for (const held of this.open) {
      held.closed = true
      held.controller.close()
    }
  }

  readonly dependencies: StreamDependencies = {
    open: async (signal) => {
      if (this.refuse === 'network') throw new TypeError('Failed to fetch')
      if (this.refuse !== undefined)
        return Response.json(
          { error: { code: this.refuse === 404 ? 'not_found' : 'unauthenticated', message: 'No.', ref: 'ref-fake' } },
          { status: this.refuse },
        )
      let held: Held | undefined
      const opening = framesOf(this.opening)
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          held = { controller, closed: false }
          this.connections.push(held)
          controller.enqueue(encoder.encode(opening))
        },
        cancel: () => {
          if (held !== undefined) held.closed = true
        },
      })
      signal.addEventListener('abort', () => {
        if (held === undefined || held.closed) return
        held.closed = true
        held.controller.error(new DOMException('The connection was closed.', 'AbortError'))
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
    read: readEvents,
  }
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
