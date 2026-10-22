// A chat's stream as the browser reads it (docs/architecture/streams.md): one GET of the chat's stream, server-sent
// events that open with its snapshots and then carry everything live. Every connection starts over: its opening
// replaces what the reducer built, so a dropped, ended or silent connection simply connects again (after a backoff
// when it failed), and nothing is resumed or read twice. A 404 or 403 stops (the chat is out of reach), a 401 is the
// session's end.
import { ErrorEnvelope } from '@goblin/contracts/api'
import * as Data from 'effect/Data'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { withRef } from '../query/app-error.ts'
import { type ReconnectScheduler, browserScheduler, reconnectDelay } from '../reconnect.ts'
import { reportUnexpected } from '../unexpected.ts'

export type StreamDependencies = {
  /** One connection to the chat's stream (`GET /conversations/:id/stream`), cancelled with `signal`. */
  readonly open: (signal: AbortSignal) => Promise<Response>
  /** Reads a server-sent events answer to its end, handing over the events of each chunk as they come (`event-streams.ts`). */
  readonly read: (response: Response, events: (events: readonly unknown[]) => void) => Promise<void>
}
/** `stopped`: the chat is out of reach, so the reader no longer tries. */
export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/** A connection that hears nothing this long, not even the server's comment frames, is given up and opened again. */
const SILENCE_MS = 45_000

const decodeEnvelope = Schema.decodeUnknownOption(ErrorEnvelope)

/** The server refused the stream: its status, and the failure its envelope named. */
export class StreamRefused extends Data.TaggedError('StreamRefused')<{
  readonly status: number
  readonly error?: ErrorEnvelope['error'] | undefined
}> {}

/** A connection that went silent past `SILENCE_MS`. */
class StreamSilent extends Data.TaggedError('StreamSilent')<{ readonly ms: number }> {}

/** What `response`'s refusal says: its status and, when it has one, its envelope's failure. */
async function refusalOf(response: Response): Promise<StreamRefused> {
  // expected: a refusal without a JSON envelope is known by its status alone
  const body: unknown = await response.json().catch(() => undefined)
  return new StreamRefused({ status: response.status, error: Option.getOrUndefined(decodeEnvelope(body))?.error })
}

/** One connection: its controller, whether the reader gave it up for its silence, and whether it heard an event. */
type Connection = { readonly controller: AbortController; silent: boolean; heard: boolean }

/**
 * Reads one chat's stream and hands each batch of events to `receive`, in order. `reconnect` (re)connects for a fresh
 * opening; `dispose` stops. `report` says how the connection is, and with `stopped` why it gave up (`failure`).
 */
export class StreamReader {
  #connection: Connection | undefined
  #cancelRetry: (() => void) | undefined
  #cancelSilence: (() => void) | undefined
  #attempt = 0
  #connected = false
  #disposed = false

  constructor(
    readonly dependencies: StreamDependencies,
    readonly receive: (events: readonly unknown[]) => void,
    readonly report: (status: StreamStatus, detail?: string, failure?: unknown) => void,
    readonly scheduler: ReconnectScheduler = browserScheduler,
  ) {}

  #detach(): void {
    this.#cancelRetry?.()
    this.#cancelRetry = undefined
    this.#cancelSilence?.()
    this.#cancelSilence = undefined
    this.#connection?.controller.abort()
    this.#connection = undefined
  }

  /** Stops reading; a later `reconnect` connects again and reports its connection again. */
  dispose(): void {
    this.#disposed = true
    this.#connected = false
    this.#detach()
  }

  /** Connects for a fresh opening, then reads live until the connection ends. Only the first connection and failures report. */
  async reconnect(): Promise<void> {
    this.#detach()
    this.#disposed = false
    const connection: Connection = { controller: new AbortController(), silent: false, heard: false }
    this.#connection = connection
    if (!this.#connected) this.report('connecting')
    try {
      const response = await this.dependencies.open(connection.controller.signal)
      if (this.#connection !== connection) return
      if (!response.ok) throw await refusalOf(response)
      if (!this.#connected || this.#attempt > 0) this.report('connected')
      this.#connected = true
      this.#listen(connection)
      await this.dependencies.read(response, (events) => {
        if (this.#connection !== connection) return
        connection.heard = true
        this.#attempt = 0
        this.#listen(connection)
        if (events.length > 0) this.receive(events)
      })
      // The server ended it (the connection's life, or it fell behind): connect again for a fresh opening.
      this.#again(connection, undefined)
    } catch (error) {
      // expected: a failed connection shows as reconnecting, with its reference, and is tried again
      this.#again(connection, connection.silent ? new StreamSilent({ ms: SILENCE_MS }) : error)
    }
  }

  /** `connection` answered, or something came on it: its silence is measured from now. */
  #listen(connection: Connection): void {
    this.#cancelSilence?.()
    this.#cancelSilence = this.scheduler.schedule(() => {
      if (this.#connection !== connection) return
      connection.silent = true
      connection.controller.abort()
    }, SILENCE_MS)
  }

  /**
   * `connection` ended, with `error` when it failed: a refusal for good stops, a connection the server ended after
   * its events connects again at once, anything else after a backoff.
   */
  #again(connection: Connection, error: unknown): void {
    if (this.#connection !== connection || this.#disposed) return
    this.#cancelSilence?.()
    this.#cancelSilence = undefined
    if (error instanceof StreamRefused && [401, 403, 404].includes(error.status)) {
      this.#connection = undefined
      this.#connected = false
      return this.report('stopped', withRef('This chat is not available', error), error)
    }
    if (error === undefined && connection.heard) {
      this.reconnect().catch(reportUnexpected)
      return
    }
    this.report('reconnecting', withRef('Connection failed', error))
    const delay = reconnectDelay(this.#attempt)
    this.#attempt += 1
    this.#cancelRetry = this.scheduler.schedule(() => void this.reconnect().catch(reportUnexpected), delay)
  }
}
