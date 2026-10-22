// A chat's stream served in memory, as `/streams/<token>` serves it: epochs of AG-UI events with offsets, catch-up and
// long-poll reads, and live reads the test drives. `join` answers the current epoch's link.
import type { ConversationStream } from '@goblin/contracts'
import type { LiveListener, StreamDependencies, StreamPage } from '../src/lib/agui/reader.ts'
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

/** A live read the server holds open: what it was opened from, and whether the reader closed it. */
export type Held = { readonly url: string; readonly offset: string; readonly listener: LiveListener; closed: boolean }

const offsetOf = (index: number) => String(index).padStart(4, '0')
const indexOf = (offset: string) => (offset === '-1' ? 0 : Number(offset))

export class FakeStream {
  /** Each epoch's events, in order; an offset is how many of them come before it. */
  readonly epochs: unknown[][] = [[]]
  readonly closed = new Set<number>()
  readonly joins: number[] = []
  readonly reads: { readonly url: string; readonly offset: string; readonly longPoll: boolean }[] = []
  readonly live: Held[] = []
  /** Answered instead of the stream's own page while set: a refusal, or a failure to reach it. */
  refuse: number | 'network' | undefined
  /** Live reads fail at once while set, as where server-sent events cannot pass. */
  liveFails = false
  /** Long polls wait for this, so a test controls when they answer. */
  waiting: (() => void) | undefined
  expiresAt = '2999-01-01T00:00:00.000Z'

  get epoch(): number {
    return this.epochs.length
  }

  /** Appends `events` to the current epoch and hands them to every live read open on it. */
  write(...events: unknown[]): void {
    this.#append(this.epoch, events, false)
  }

  /**
   * The chat goes on in a new epoch opened with `events`; the old one ends with `goblin.stream.moved` and closes, as
   * the producer moves a stream.
   */
  move(...events: unknown[]): void {
    const old = this.epoch
    this.epochs.push([...events])
    this.closed.add(old)
    this.#append(old, [{ type: 'CUSTOM', name: 'goblin.stream.moved', value: { epoch: old + 1 } }], true)
  }

  #append(epoch: number, events: readonly unknown[], closed: boolean): void {
    const current = this.epochs[epoch - 1] ?? []
    current.push(...events)
    const next = offsetOf(current.length)
    for (const held of this.live)
      if (!held.closed && held.url === this.#url(epoch)) held.listener.events(events, next, closed)
  }

  /** Every open live read drops, as the network does. */
  drop(): void {
    for (const held of this.live.filter(({ closed }) => !closed)) {
      held.closed = true
      held.listener.error()
    }
  }

  #url = (epoch: number) => `https://app.test/streams/e${epoch}`

  #page(url: string, offset: string): StreamPage {
    const epoch = Number(/e(\d+)$/u.exec(url)?.[1])
    const events = this.epochs[epoch - 1] ?? []
    const rest = events.slice(indexOf(offset))
    return {
      status: 200,
      events: rest,
      next: offsetOf(events.length),
      closed: this.closed.has(epoch),
      upToDate: true,
    }
  }

  readonly dependencies: StreamDependencies = {
    join: async () => {
      this.joins.push(this.epoch)
      const link: ConversationStream = {
        url: this.#url(this.epoch),
        epoch: this.epoch,
        tier: 'full',
        expiresAt: this.expiresAt,
      }
      return link
    },
    transport: {
      read: async (url, offset, longPoll) => {
        this.reads.push({ url, offset, longPoll })
        if (this.refuse === 'network') throw new TypeError('Failed to fetch')
        if (this.refuse !== undefined)
          return { status: this.refuse, events: [], next: undefined, closed: false, upToDate: true }
        if (longPoll && this.#page(url, offset).events.length === 0)
          await new Promise<void>((resolve) => (this.waiting = resolve))
        return this.#page(url, offset)
      },
      live: (url, offset, listener) => {
        const held: Held = { url, offset, listener, closed: false }
        this.live.push(held)
        if (this.liveFails) {
          held.closed = true
          queueMicrotask(() => listener.error())
        }
        return () => {
          held.closed = true
        }
      },
    },
  }
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
