import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'
import { PersonaName } from './personas.ts'
import { RoutineDefinition, RoutineHandOverFields, RoutineTellMe, RoutineTrigger } from './routines.ts'
import { SourceKey, SourceOthers, SourceRead, SourceReply, SourceTitle, SourceWake, SpeaksForMe } from './sources.ts'

/** Places in model-authored proposals are names; the runtime resolves their stable identities. */
const TopicName = NonEmptyString(80)
export const AskedSourceRoute = Schema.Union([
  Schema.Struct({ to: Schema.Literal('topic'), topic: TopicName }),
  Schema.Struct({ to: Schema.Literal('listen'), topic: TopicName }),
  Schema.Struct({ to: Schema.Literal('persona'), persona: PersonaName, topic: Schema.optionalKey(TopicName) }),
  Schema.Struct({ to: Schema.Literal('ignore') }),
  Schema.Struct({ to: Schema.Literal('held') }),
])
export type AskedSourceRoute = typeof AskedSourceRoute.Type

/** The same Source request is used by individual and composed proposals. */
export const AskedSource = Schema.Struct({
  connectionId: NonEmptyString(200),
  title: SourceTitle,
  wake: SourceWake,
  key: SourceKey,
  speaksForMe: SpeaksForMe,
  others: SourceOthers,
  read: SourceRead,
  reply: Schema.optionalKey(SourceReply),
  newKeys: Schema.optionalKey(Schema.Union([AskedSourceRoute, Schema.Struct({ to: Schema.Literal('topic-per-key') })])),
})
export type AskedSource = typeof AskedSource.Type

/** The runtime pins the revision of the Persona named by the model. */
const AskedHandTo = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({ kind: Schema.Literal('goblin'), ...RoutineHandOverFields }),
  Schema.Struct({ kind: Schema.Literal('persona'), persona: PersonaName, ...RoutineHandOverFields }),
])
export const AskedRoutine = Schema.Struct({
  title: RoutineDefinition.fields.title,
  trigger: RoutineTrigger,
  timezone: RoutineDefinition.fields.timezone,
  tellMe: RoutineTellMe,
  handTo: AskedHandTo,
  topic: Schema.optionalKey(TopicName),
}).check(
  Schema.makeFilter(
    (asked) =>
      asked.handTo.kind !== 'none' || asked.tellMe.on || 'A routine that hands nothing over must tell the owner.',
  ),
)
export type AskedRoutine = typeof AskedRoutine.Type
