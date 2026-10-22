// A chat's AG-UI stream served to a browser fixture page, as the agent serves it: `GET …/conversations/:id/stream`
// answers server-sent events that open with the chat as it is, then carry what the test writes next. A stand-in for
// the page's `fetch` answers each stream request itself (Playwright cannot hold a response open), its opening read
// from `/__fixture/streams/<chat>`, which the test routes. Only the stream's transport is faked; the page's reader,
// reducer and components are the real ones.
import { RunInput } from '@goblin/contracts'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import type { Page, Route } from 'playwright-core'

/** Where the page's stand-in reads a chat's opening; route it to the chat's `FixtureStream.opening`. */
export const OPENINGS = '**/__fixture/streams/**'

/** The chat an opening request is for. */
export const openingChat = (route: Route): string => new URL(route.request().url()).pathname.split('/').at(-1) ?? ''

/**
 * The page's `fetch` stand-in, installed before the page loads: a chat's stream is a body of `data:` frames, its
 * opening first, then each batch the test writes (`fixture-agui`, for one chat) or the page dispatches
 * (`fixture-batch`, for any). `fixture-agui-drop` makes every open stream fail, as a dropped connection does.
 * `data-streams` on the root counts the streams opened.
 */
export async function installLiveReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let opened = 0
    const native = window.fetch.bind(window)
    const encoder = new TextEncoder()
    const frames = (events: readonly unknown[]) =>
      encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    const stream = (chat: string, opening: readonly unknown[], signal: AbortSignal | null | undefined) => {
      const listeners: [string, (event: Event) => void][] = []
      let open = true
      const stop = () => {
        open = false
        for (const [type, listener] of listeners) window.removeEventListener(type, listener)
      }
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frames(opening))
          const fail = (error: unknown) => {
            if (!open) return
            stop()
            controller.error(error)
          }
          listeners.push(
            [
              'fixture-agui',
              (event) => {
                const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
                if (typeof detail !== 'object' || detail === null || !('chat' in detail) || !('events' in detail))
                  return
                if (detail.chat === chat && Array.isArray(detail.events)) controller.enqueue(frames(detail.events))
              },
            ],
            [
              'fixture-batch',
              (event) => {
                const data: unknown = event instanceof MessageEvent ? event.data : undefined
                const batch: unknown = typeof data === 'string' ? JSON.parse(data) : undefined
                if (Array.isArray(batch)) controller.enqueue(frames(batch))
              },
            ],
            ['fixture-agui-drop', () => fail(new TypeError('network error'))],
          )
          for (const [type, listener] of listeners) window.addEventListener(type, listener)
          signal?.addEventListener('abort', () => fail(new DOMException('The connection was closed.', 'AbortError')))
        },
        cancel: stop,
      })
    }
    const STREAM = /\/conversations\/([^/]+)\/stream$/u
    const standIn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
      const chat = STREAM.exec(url.pathname)?.[1]
      if (chat === undefined) return native(input, init)
      const answered = await native(`/__fixture/streams/${chat}`)
      if (!answered.ok) return answered
      const opening: unknown = await answered.json()
      document.documentElement.dataset['streams'] = String(++opened)
      const body = stream(chat, Array.isArray(opening) ? opening : [], init?.signal)
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    Object.defineProperty(window, 'fetch', { value: standIn, configurable: true, writable: true })
  })
}

/** One chat's stream: its events so far, what a new connection opens with. */
export class FixtureStream {
  readonly #events: unknown[]
  /** How many connections the page opened, each reading its opening once. */
  reads = 0

  constructor(
    readonly chat: string,
    opening: readonly unknown[],
  ) {
    this.#events = [...opening]
  }

  /**
   * A new connection's opening: the chat's events so far, which the page's reducer folds into what a fresh snapshot
   * of the chat would give it.
   */
  async opening(route: Route): Promise<void> {
    this.reads += 1
    await route.fulfill({ json: this.#events })
  }

  /** Writes `events`, and hands them to the connections open on this stream. */
  async write(page: Page, ...events: readonly unknown[]): Promise<void> {
    this.#events.push(...events)
    const detail = { chat: this.chat, events }
    await page.evaluate((sent) => window.dispatchEvent(new CustomEvent('fixture-agui', { detail: sent })), detail)
  }
}

/** Every stream the page holds fails, as when the network drops. */
export const dropLiveReads = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('fixture-agui-drop')))

const decodeSend = Schema.decodeUnknownSync(RunInput)

/**
 * What the page sent in a send's body (AG-UI's `RunAgentInput`, ADR 0111): its last message's words as `input`, its
 * run id as `operationId`, and goblin's parts from `forwardedProps.goblin`.
 */
export function sentOf(body: unknown) {
  const send = decodeSend(body)
  const last = send.messages.at(-1)
  const input = Predicate.hasProperty(last, 'content') && typeof last.content === 'string' ? last.content : ''
  return { input, operationId: send.runId, ...send.forwardedProps?.goblin }
}
