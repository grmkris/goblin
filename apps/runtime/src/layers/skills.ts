import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { Chats, Conversations } from '../chats/service.ts'
import type { Files } from '../files/service.ts'
import type { McpConnections } from '../mcp/service.ts'
import { CheapModels } from '../memory/model.ts'
import type { Notices } from '../notices/service.ts'
import type { SingleFlight } from '../observability/single-flight.ts'
import type { PiSessions } from '../pi/sessions.ts'
import type { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { sessionScope } from '../setup/scope.ts'
import { makeLearner } from '../skills/learner.ts'
import { makeSkills } from '../skills/library.ts'
import { Learner, Skills } from '../skills/service.ts'
import { SqliteDraftLog, SqliteSkillState } from '../skills/store.ts'

/** Start step 9: skills from the owner's MCP libraries, over the host's connections and the skills state. */
export const SkillsLive: Layer.Layer<Skills, never, Db | McpConnections | SingleFlight> = Layer.effect(
  Skills,
  Effect.gen(function* () {
    return yield* makeSkills(new SqliteSkillState(yield* Db))
  }),
)

/**
 * The skill learner, after the start: it writes its drafts to the owner's files and tells them with a notice, so it is
 * built over the files (`AppsLive`) and the routines' notices (`RoutinesLive`) as well as the skills (start step 9).
 */
export const LearnerLive: Layer.Layer<
  Learner,
  never,
  Db | Skills | CheapModels | Files | PiSessions | SingleFlight | Chats | Notices | Conversations | Changes
> = Layer.effect(
  Learner,
  Effect.gen(function* () {
    const db = yield* Db
    const cheap = yield* CheapModels
    return yield* makeLearner({
      drafts: new SqliteDraftLog(db),
      state: new SqliteSkillState(db),
      skills: yield* Skills,
      model: cheap('skill'),
      room: (session) => sessionScope(db, session).room !== undefined,
    })
  }),
)
