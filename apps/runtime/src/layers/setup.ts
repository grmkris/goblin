import type { HelperExclusion, TopicSetup } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  type PiTools,
  type Retooling,
  appAllowed,
  sessionScope,
  configureHelper,
  piToolsFor,
  retoolTopic,
  routinesOutside,
  syncPi,
} from '../setup/scope.ts'
import { Setups } from '../setup/service.ts'
import { epochSeconds } from '../clock.ts'
import { attempt } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { Db } from '../runtime/db.ts'
import type { Retooled } from '../agent-model.ts'
import { AgentInput } from '../runtime/input.ts'

// What each chat may use, as functions of the agent's database (setup/scope.ts), served by `SetupsLive`.

/**
 * Sets a conversation's Pi tool filter (the tools its turn's power does not reach, and the subagent tools where they
 * are switched off), leaving its extensions as they are. The session's next turn sets its own sender's again
 * (`useTools`, which forgets what it applied here).
 */
const retool = (harness: PiHarness, retooled: Retooled) => async (session: string, tools: PiTools) => {
  const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  await conversation?.configure({ tools }, BACKGROUND)
  retooled.delete(session)
}

/** How the switches reach Pi: the agent's database, the tool sets its filters remove and its harness. */
const retooling: Effect.Effect<Retooling, never, AgentInput | Db> = Effect.gen(function* () {
  const { toolSets, harness, retooled } = yield* AgentInput
  return { db: yield* Db, toolSets, retool: retool(harness, retooled) }
})

/** What each chat may use, over the agent's database, applied to Pi through its harness. */
export const SetupsLive: Layer.Layer<Setups, never, AgentInput | Db> = Layer.effect(
  Setups,
  Effect.gen(function* () {
    const pi = yield* retooling
    const { db } = pi
    return Setups.of({
      scope: Effect.fn('Setups.scope')(function* (session: string) {
        return yield* Effect.sync(() => sessionScope(db, session))
      }),
      app: Effect.fn('Setups.app')(function* (session: string, app: string) {
        return yield* Effect.sync(() => appAllowed(db, session, app))
      }),
      configureHelper: Effect.fn('Setups.configureHelper')(function* (
        parent: string,
        session: string,
        exclusions: readonly HelperExclusion[],
      ) {
        const now = yield* epochSeconds
        yield* attempt(() => configureHelper(pi, { parent, session, exclusions }, now))
      }),
      piTools: Effect.fn('Setups.piTools')(function* (session: string) {
        return yield* Effect.sync(() => piToolsFor(db, pi.toolSets, session))
      }),
      syncPi: Effect.fn('Setups.syncPi')(function* (session: string) {
        yield* attempt(() => syncPi(pi, session))
      }),
      retoolTopic: Effect.fn('Setups.retoolTopic')(function* (topic: number) {
        yield* attempt(() => retoolTopic(pi, topic))
      }),
      routinesOutside: Effect.fn('Setups.routinesOutside')(function* (topic: number, setup: TopicSetup) {
        return yield* Effect.sync(() => routinesOutside(db, topic, setup))
      }),
    })
  }),
)
