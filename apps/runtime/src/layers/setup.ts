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
import { AgentInput } from '../runtime/input.ts'

// What each chat may use, as functions of the agent's database (setup/scope.ts), served by `SetupsLive`.

/** Sets a conversation's Pi tool filter (where subagents are switched off), leaving its extensions as they are. */
const retool = (harness: PiHarness) => async (session: string, tools: PiTools) => {
  const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  await conversation?.configure({ tools }, BACKGROUND)
}

/** How the switches reach Pi: the agent's database, its subagent tools and its harness. */
const retooling: Effect.Effect<Retooling, never, AgentInput | Db> = Effect.gen(function* () {
  const { subagentTools, harness } = yield* AgentInput
  return { db: yield* Db, subagentTools, retool: retool(harness) }
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
        return yield* Effect.sync(() => piToolsFor(db, pi.subagentTools, session))
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
