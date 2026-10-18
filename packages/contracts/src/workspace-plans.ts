import * as Schema from 'effect/Schema'
import { ChatId, NonEmptyString, TopicId } from './ids.ts'
import { RoutineDefinition, RoutineView } from './routines.ts'
import { SourceSetup, SourceTitle, SourceView } from './sources.ts'
import { TopicView } from './topics.ts'

/** A composition of existing Sources and routines, prepared together for one owner review. */
export const WorkspacePlanProposal = Schema.Struct({
  title: NonEmptyString(120),
  purpose: NonEmptyString(2000),
  sources: Schema.Array(
    Schema.Struct({
      connectionId: NonEmptyString(200),
      title: SourceTitle,
      setup: SourceSetup,
    }),
  ).check(Schema.isMaxLength(8)),
  routines: Schema.Array(Schema.Struct({ topic: TopicId, definition: RoutineDefinition })).check(Schema.isMaxLength(8)),
}).check(
  Schema.makeFilter((plan) => plan.sources.length + plan.routines.length > 0 || 'Include a Source or a routine.'),
)
export type WorkspacePlanProposal = typeof WorkspacePlanProposal.Type

export const WorkspacePlanId = Schema.String.check(Schema.isPattern(/^wsp_[0-9a-f]{32}$/u))
export const WorkspacePlanItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('source'), source: SourceView }),
  Schema.Struct({ kind: Schema.Literal('routine'), routine: RoutineView }),
])
export type WorkspacePlanItem = typeof WorkspacePlanItem.Type

/** Frozen review plus durable progress. Ready means configuration applied, never external delivery verified. */
export const WorkspacePlanView = Schema.Struct({
  id: WorkspacePlanId,
  chat: ChatId,
  revision: Schema.Int,
  title: Schema.String,
  purpose: Schema.String,
  state: Schema.Literals(['preparing', 'proposed', 'applying', 'ready', 'attention']),
  items: Schema.Array(WorkspacePlanItem),
  topics: Schema.Array(TopicView),
  completed: Schema.Array(Schema.Int),
  problem: Schema.NullOr(Schema.String),
  continuation: Schema.Literals(['pending', 'sent', 'kept']),
  createdAt: Schema.Number,
})
export type WorkspacePlanView = typeof WorkspacePlanView.Type
export const WorkspacePlanPage = Schema.Struct({ plans: Schema.Array(WorkspacePlanView) })
export const WorkspacePlanDecision = Schema.Struct({ revision: Schema.Int })
export type WorkspacePlanDecision = typeof WorkspacePlanDecision.Type
