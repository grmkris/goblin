// A chat's stream as the browser reads it (docs/architecture/streams.md): joined through the API, then read at the
// signed URL the join answers, with the Durable Streams protocol: what was written since the last offset, then live,
// over server-sent events or, where those fail, long polls. A dropped read resumes from the last offset it applied; an
// expired link, a closed stream or `goblin.stream.moved` joins again, and a new epoch starts from its beginning.
import { CustomName, type ConversationStream } from '@goblin/contracts'
import { withRef } from '../query/app-error.ts'
import { type ReconnectScheduler, browserScheduler, reconnectDelay } from '../reconnect.ts'
import { reportUnexpected } from '../unexpected.ts'
import { records } from '../values.ts'

/** What one read of the stream answered: its HTTP status, the events, the offset to read from next, and whether it ended. */
export type StreamPage = {
  readonly status: number
  readonly events: readonly unknown[]
  readonly next: string | undefined
  readonly closed: boolean
  readonly upToDate: boolean
}
/** What a live read hears: events with the offset after them, or that the stream closed; `error` when it dropped. */
export type LiveListener = {
  readonly events: (events: readonly unknown[], next: string, closed: boolean) => void
  readonly error: () => void
}
/** How the reader reaches the stream: one read (catch-up or a long poll), and a live read it can close. */
export type StreamTransport = {
  readonly read: (url: string, offset: string, longPoll: boolean, signal: AbortSignal) => Promise<StreamPage>
  readonly live: (url: string, offset: string, listener: LiveListener) => () => void
}
export type StreamDependencies = {
  /** `GET /conversations/:id/stream`: where to read the chat's stream now. */
  readonly join: (signal: AbortSignal) => Promise<ConversationStream>
  readonly transport: StreamTransport
}
export type StreamStatus = 'connecting' | 'connected' | 'reconnecting'

/** A link this close to its expiry is joined again before it is read. */
const EXPIRY_MARGIN_MS = 15_000
/** Live reads that drop before they hear anything, in a row, after which this tab reads by long polls. */
const LIVE_FAILURES = 2

const moved = (events: readonly unknown[]): boolean =>
  records(events).some((event) => event.type === 'CUSTOM' && event.name === CustomName.streamMoved)

/** A read that was refused or that the stream ended: the reader joins again. */
class Rejoin extends Error {}

/**
 * Reads one chat's stream and hands each batch of events to `receive`, in order, once. `reconnect` (re)starts reading
 * from where it left off; `dispose` stops. `report` says how the connection is.
 */
export class StreamReader {
  #link: ConversationStream | undefined
  /** The offset of epoch `#link.epoch` after the events applied so far. */
  #offset = '-1'
  #epoch = 0
  #controller: AbortController | undefined
  #closeLive: (() => void) | undefined
  #cancelRetry: (() => void) | undefined
  #attempt = 0
  #liveFailures = 0
  #connected = false
  #disposed = false

  constructor(
    readonly dependencies: StreamDependencies,
    readonly receive: (events: readonly unknown[]) => void,
    readonly report: (status: StreamStatus, detail?: string) => void,
    readonly scheduler: ReconnectScheduler = browserScheduler,
    readonly now: () => number = Date.now,
  ) {}

  /** Whether this tab gave up on live reads for long polls. */
  #polling(): boolean {
    return this.#liveFailures >= LIVE_FAILURES
  }

  #detach(): void {
    this.#cancelRetry?.()
    this.#cancelRetry = undefined
    this.#controller?.abort()
    this.#controller = undefined
    this.#closeLive?.()
    this.#closeLive = undefined
  }

  /** Stops reading; a later `reconnect` reads on from the same offset and reports its connection again. */
  dispose(): void {
    this.#disposed = true
    this.#connected = false
    this.#detach()
  }

  /** Reads again from the last offset: what was missed, then live. Only the first connection and failures report. */
  async reconnect(): Promise<void> {
    this.#detach()
    this.#disposed = false
    const controller = new AbortController()
    this.#controller = controller
    if (!this.#connected) this.report('connecting')
    try {
      await this.#catchUp(controller.signal)
      if (controller.signal.aborted) return
      if (!this.#connected || this.#attempt > 0) this.report('connected')
      this.#connected = true
      this.#attempt = 0
      if (this.#polling())
        this.#poll(controller).catch((error: unknown) => {
          // expected: a failed poll shows as reconnecting, with its reference, and is retried
          this.#reportAndRetry(controller, error)
        })
      else this.#listen(controller)
    } catch (error) {
      // expected: a failed read shows as reconnecting, with its reference, and is retried
      this.#reportAndRetry(controller, error)
    }
  }

  /** A read failed: once more at once when it only has to join again, otherwise after a backoff. */
  #reportAndRetry(controller: AbortController, error: unknown): void {
    if (controller.signal.aborted || this.#disposed) return
    if (error instanceof Rejoin) {
      this.#link = undefined
      if (this.#attempt === 0) {
        this.#attempt = 1
        this.reconnect().catch(reportUnexpected)
        return
      }
    }
    this.report('reconnecting', withRef('Connection failed', error))
    const delay = reconnectDelay(this.#attempt)
    this.#attempt += 1
    this.#cancelRetry = this.scheduler.schedule(() => void this.reconnect(), delay)
  }

  /** Where to read: the link held, or a new one; a new epoch is read from its beginning. */
  async #url(signal: AbortSignal): Promise<string> {
    const held = this.#link
    if (held !== undefined && Date.parse(held.expiresAt) - this.now() > EXPIRY_MARGIN_MS) return held.url
    const link = await this.dependencies.join(signal)
    if (link.epoch !== this.#epoch) {
      this.#epoch = link.epoch
      this.#offset = '-1'
    }
    this.#link = link
    return link.url
  }

  /** `page`'s events, applied; a refusal, the stream's end or its move asks for a join. */
  #apply(page: StreamPage): void {
    if (page.status === 401 || page.status === 403 || page.status === 404) throw new Rejoin(`HTTP ${page.status}`)
    if (page.status >= 400) throw new Error(`Stream read failed: HTTP ${page.status}`)
    this.#take(page.events, page.next)
    if (page.closed || moved(page.events)) throw new Rejoin('The stream moved')
  }

  #take(events: readonly unknown[], next: string | undefined): void {
    if (next !== undefined) this.#offset = next
    if (events.length > 0) this.receive(events)
  }

  /** Everything written since the last offset, page by page, until the reader is up to date. */
  async #catchUp(signal: AbortSignal): Promise<void> {
    for (;;) {
      const url = await this.#url(signal)
      const page = await this.dependencies.transport.read(url, this.#offset, false, signal)
      if (signal.aborted) return
      this.#apply(page)
      if (page.upToDate) return
    }
  }

  /** Live over server-sent events; a drop reads what was missed and listens again. */
  #listen(controller: AbortController): void {
    const url = this.#link?.url
    if (url === undefined) return
    let heard = false
    this.#closeLive = this.dependencies.transport.live(url, this.#offset, {
      events: (events, next, closed) => {
        if (controller.signal.aborted) return
        heard = true
        this.#liveFailures = 0
        this.#take(events, next)
        if (!closed && !moved(events)) return
        this.#link = undefined
        this.#again(controller)
      },
      error: () => {
        if (controller.signal.aborted) return
        if (!heard) this.#liveFailures += 1
        this.#again(controller)
      },
    })
  }

  /** The live read ended (the server recycles it, the stream moved, the network dropped): read on from the offset. */
  #again(controller: AbortController): void {
    this.#closeLive?.()
    this.#closeLive = undefined
    if (controller.signal.aborted || this.#disposed) return
    this.reconnect().catch(reportUnexpected)
  }

  /** Live by long polls, for as long as nothing stops it. */
  async #poll(controller: AbortController): Promise<void> {
    const { signal } = controller
    while (!signal.aborted) {
      const url = await this.#url(signal)
      const page = await this.dependencies.transport.read(url, this.#offset, true, signal)
      if (signal.aborted) return
      this.#apply(page)
    }
  }
}
