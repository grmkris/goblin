import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { attemptSync } from '../http/errors.ts'
import type { KeyGrant } from '../http/api/principal.ts'
import { reportAndRecover } from '../observability/report.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { nameReach } from './reach.ts'

/**
 * The names of the keys that made the agent's Topics and Personas (ADR 0108), learnt from each key's first request in
 * the object's lifetime: whatever the key made before names were kept is named then, and the views of what that named
 * are told. A key's name never changes, so once is enough; a restart only names nothing again.
 */
export class KeyNames extends Context.Service<
  KeyNames,
  {
    /** Names what `key` made without a name, the first time it asks in this lifetime; never fails its request. */
    readonly learn: (key: KeyGrant) => Effect.Effect<void>
  }
>()('goblin/keys/KeyNames') {
  static readonly layer = Layer.effect(
    KeyNames,
    Effect.gen(function* () {
      const db = yield* Db
      const changes = yield* Changes
      const learnt = new Set<string>()
      return KeyNames.of({
        learn: (key) =>
          learnt.has(key.keyId)
            ? Effect.void
            : Effect.gen(function* () {
                const named = yield* attemptSync(() => nameReach(db, key))
                learnt.add(key.keyId)
                const ids = (kind: 'topic' | 'persona') => named.filter((row) => row.kind === kind).map((row) => row.id)
                if (ids('topic').length > 0) yield* changes.publish('topics.changed', { ids: ids('topic') })
                if (ids('persona').length > 0) yield* changes.publish('personas.changed', { ids: ids('persona') })
              }).pipe(reportAndRecover('keys.learn', undefined)),
      })
    }),
  )
}
