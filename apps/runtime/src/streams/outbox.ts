import type { StreamTier } from '@goblin/contracts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import { attempt } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import type { SingleFlight } from '../observability/single-flight.ts'
import { acknowledged, dropEpoch, pendingWrites } from './store.ts'
import { type StreamsFetch, send, streamPath } from './writer.ts'

// The outbox's drain (docs/architecture/streams.md): a stream's writes go out in order, one drain per stream at a
// time, outside any transaction. A write the stream acknowledged (a retry's duplicate included) is deleted; one that may
// not have arrived goes again, the same bytes, after a backoff; a stream that is gone or out of step loses its epoch's
// writes, and the producer moves the chat to a new epoch.

/** How long a stream's writes wait before they go again, by failed attempt; the last one repeats. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 15_000, 30_000]

/** What a drain needs: the database, the stream objects, the agent's workspace and where a lost epoch is reported. */
export type OutboxPorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly fetchStream: StreamsFetch
  readonly workspaceId: string
  readonly flights: SingleFlight['Service']
  readonly scope: Scope.Scope
  /** The stream of `key` lost epoch `epoch`: none of its writes went out after this. */
  readonly lost: (key: string, epoch: number) => Effect.Effect<void>
}

/** The chat and tier a stream key names. */
export const keyParts = (key: string): { readonly chat: string; readonly tier: StreamTier } => {
  const slash = key.lastIndexOf('/')
  return { chat: key.slice(0, slash), tier: key.slice(slash + 1) === 'answers' ? 'answers' : 'full' }
}

/** Sends the stream's writes in order until none is left (`done`) or one may not have arrived (`retry`). */
const drainOnce = (ports: OutboxPorts, key: string) =>
  Effect.gen(function* () {
    const { chat, tier } = keyParts(key)
    for (;;) {
      const [next] = pendingWrites(ports.db, key)
      if (next === undefined) return 'done' as const
      const path = streamPath(ports.workspaceId, chat, tier, next.epoch)
      const sent = yield* attempt(() => send(ports.fetchStream, path, next), 'streams.send')
      if (sent === 'retry') return 'retry' as const
      if (sent === 'ok') {
        acknowledged(ports.db, key, next)
        continue
      }
      dropEpoch(ports.db, key, next.epoch)
      yield* ports.lost(key, next.epoch)
    }
  })

/** The drain of each stream, with its retries. */
export function outbox(ports: OutboxPorts) {
  const failures = new Map<string, number>()
  const waiting = new Set<string>()
  const drain = (key: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (;;) {
        const result = yield* ports.flights.run(`streams.drain:${key}`, drainOnce(ports, key))
        if (result === 'retry') return yield* retryLater(key)
        failures.delete(key)
        // A write added while the drain in flight was finishing waits for no other.
        if (pendingWrites(ports.db, key).length === 0) return
      }
    }).pipe(reportAndRecover('streams.drain', undefined))
  const retryLater = (key: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (waiting.has(key)) return Effect.void
      const tries = failures.get(key) ?? 0
      failures.set(key, tries + 1)
      waiting.add(key)
      const delay = BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)] ?? 30_000
      const later = Effect.sleep(delay).pipe(
        Effect.andThen(Effect.sync(() => waiting.delete(key))),
        Effect.andThen(Effect.suspend(() => drain(key))),
      )
      return Effect.asVoid(Effect.forkIn(later, ports.scope))
    })
  return {
    /** Drains the stream now and waits for it; a write that may not have arrived is tried again later. */
    drain,
    /** Starts the stream's drain without waiting for it. */
    request: (key: string): Effect.Effect<void> => Effect.asVoid(Effect.forkIn(drain(key), ports.scope)),
  }
}
