import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { attemptSync } from '../http/errors.ts'
import type { Credential } from '../http/api/principal.ts'
import { reportAndRecover } from '../observability/report.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { nameMade } from './made-by.ts'

/**
 * The names of the keys that made the agent's Topics and Personas (ADR 0115), learnt from each key's first request in
 * the object's lifetime: whatever the key made before names were kept is named then, and the views of what that named
 * are told. A key's name never changes, so once is enough; a restart only names nothing again. The naming runs beside
 * the request, never in it: a key that made hundreds of Topics would otherwise wait for every view to be told.
 */
export class KeyNames extends Context.Service<
  KeyNames,
  {
    /** Names what `key` made without a name, the first time it asks in this lifetime; never fails or holds its request. */
    readonly learn: (key: Credential) => Effect.Effect<void>
  }
>()('goblin/keys/KeyNames') {
  static readonly layer = Layer.effect(
    KeyNames,
    Effect.gen(function* () {
      const db = yield* Db
      const changes = yield* Changes
      const scope = yield* Effect.scope
      const learnt = new Set<string>()
      return KeyNames.of({
        learn: (key) => {
          if (learnt.has(key.id)) return Effect.void
          learnt.add(key.id)
          const naming = Effect.gen(function* () {
            const named = yield* attemptSync(() => nameMade(db, { keyId: key.id, name: key.name }))
            const ids = (kind: 'topic' | 'persona') => named.filter((row) => row.kind === kind).map((row) => row.id)
            if (ids('topic').length > 0) yield* changes.publish('topics.changed', { ids: ids('topic') })
            if (ids('persona').length > 0) yield* changes.publish('personas.changed', { ids: ids('persona') })
          }).pipe(
            // A failed naming is tried again by the key's next request in this lifetime.
            Effect.tapError(() => Effect.sync(() => learnt.delete(key.id))),
            reportAndRecover('keys.learn', undefined),
          )
          return Effect.asVoid(Effect.forkIn(naming, scope))
        },
      })
    }),
  )
}
