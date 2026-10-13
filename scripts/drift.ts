/** Inspect actual provider attributes without repairing infrastructure or printing configuration values. */
import * as Alchemist from 'alchemy/Alchemist'
import { encodeState, State } from 'alchemy/State'
import { Config, Effect, Schema } from 'effect'
import { resolve } from 'node:path'
import { canonical, observed } from './drift-attributes.ts'

const RecordValue = Schema.Record(Schema.String, Schema.Unknown)
const record = Schema.decodeUnknownSync(RecordValue)
const state = Schema.decodeUnknownSync(Schema.Struct({ attr: RecordValue }))

const program = Effect.gen(function* () {
  const stage = yield* Config.String('GOBLIN_STAGE')
  const snapshot = yield* Alchemist.Drift.inspect({
    entrypoint: resolve(import.meta.dirname, '../apps/web/alchemy.run.ts'),
    stage,
  })
  // The persisted attributes come from the store the stack itself configures (scripts/alchemy-state.ts), read as the
  // JSON a store holds: the encoded record, round-tripped, exactly what a local state file contains.
  const store = yield* Effect.flatten(State).pipe(Effect.provide(snapshot.session.context))
  const mismatches: string[] = []
  for (const resource of snapshot.resources) {
    const value = yield* store.get({ stack: snapshot.stack.name, stage, fqn: resource.fqn })
    const persisted = value === undefined ? undefined : state(JSON.parse(JSON.stringify(encodeState(value))))
    if (
      resource.status === 'missing' ||
      persisted === undefined ||
      canonical(observed(resource.fqn, persisted.attr)) !== canonical(observed(resource.fqn, record(resource.actual)))
    )
      mismatches.push(resource.fqn)
  }
  if (mismatches.length > 0) return yield* Effect.die(new Error(`cloud_drift: ${mismatches.join(',')}`))
  return {
    stage,
    drift: 'verified',
    resources: snapshot.resources.map(({ fqn }) => fqn),
    providerNormalizations: [
      'Web.domain.zone is deployment bookkeeping',
      'goblinAuth.readReplication defaults to disabled',
    ],
  }
})

console.info(JSON.stringify(await Effect.runPromise(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped))))
