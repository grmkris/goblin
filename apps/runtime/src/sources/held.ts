// Messages held while the place they came from waits for the owner's route, shared by the Telegram channel and
// Sources: the twenty newest of a place are kept and the rest counted, and once it has a route they are delivered in
// order, the count of those dropped told before the first.
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'

/** How many messages a waiting place keeps; older ones are dropped and counted. */
export const HELD_LIMIT = 20

/** One place's held messages as their table keeps them. */
export type HeldShelf = {
  /** Keeps one more message; holding the same one again changes nothing. */
  readonly put: () => void
  /** The ids of every message the place holds, newest first. */
  readonly newestFirst: () => readonly string[]
  /** Drops these messages and counts them on the place. */
  readonly drop: (ids: readonly string[]) => void
}

/** Puts one message on `shelf`, keeping its place's newest twenty, in one short transaction. */
export function holdNewest(db: DrizzleSqliteDODatabase, shelf: HeldShelf): void {
  db.transaction(() => {
    shelf.put()
    const dropped = shelf.newestFirst().slice(HELD_LIMIT)
    if (dropped.length > 0) shelf.drop(dropped)
  })
}

/**
 * Delivers what a place held once it has a route, oldest first, and releases each one after it went: how many were
 * dropped while this `place` (a chat, a conversation) waited goes before the first.
 */
export const deliverHeld = <H, E, R>(
  ready: readonly H[],
  dropped: number,
  place: string,
  deliver: (held: H, note: string) => Effect.Effect<void, E, R>,
  release: (held: H) => void,
) =>
  Effect.gen(function* () {
    let note = dropped === 0 ? '' : `(${String(dropped)} earlier messages were not kept while this ${place} waited.)\n`
    for (const held of ready) {
      yield* deliver(held, note)
      release(held)
      note = ''
    }
  })
