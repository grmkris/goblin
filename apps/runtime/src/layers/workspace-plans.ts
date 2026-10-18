import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { epochSeconds } from '../clock.ts'
import { attemptSync } from '../http/errors.ts'
import { Db } from '../runtime/db.ts'
import { WorkspacePlans } from '../workspace-plans/service.ts'
import { WorkspacePlanStore } from '../workspace-plans/store.ts'

/** Durable reviews and progress, built once over the agent's application database. */
export const WorkspacePlansLive = Layer.effect(
  WorkspacePlans,
  Effect.gen(function* () {
    const store = new WorkspacePlanStore(yield* Db)
    return WorkspacePlans.of({
      list: attemptSync(() => store.list()),
      get: (id) => attemptSync(() => store.get(id)),
      begin: Effect.fn('WorkspacePlans.begin')(function* (id, operationId, chat, proposal) {
        const now = yield* epochSeconds
        return yield* attemptSync(() => store.begin(id, operationId, chat, proposal, now))
      }),
      save: (view) => attemptSync(() => store.save(view)),
      proposal: (id) => attemptSync(() => store.proposal(id)),
    })
  }),
)
