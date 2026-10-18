import type { TopicView, WorkspacePlanItem, WorkspacePlanProposal, WorkspacePlanView } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'

/** The one setup-proposal store of an agent. Application records only; no second execution engine. */
export class WorkspacePlans extends Context.Service<
  WorkspacePlans,
  {
    readonly list: Effect.Effect<readonly WorkspacePlanView[], AppError>
    readonly get: (id: string) => Effect.Effect<WorkspacePlanView, AppError>
    readonly begin: (
      id: string,
      operationId: string,
      chat: string,
      proposal: WorkspacePlanProposal,
    ) => Effect.Effect<WorkspacePlanView, AppError>
    /** Commit local primitive proposals and their review in one synchronous transaction. */
    readonly prepared: (
      id: string,
      topics: readonly TopicView[],
      writes: readonly (() => WorkspacePlanItem)[],
    ) => Effect.Effect<WorkspacePlanView, AppError>
    readonly save: (view: WorkspacePlanView) => Effect.Effect<WorkspacePlanView, AppError>
    readonly proposal: (id: string) => Effect.Effect<WorkspacePlanProposal, AppError>
  }
>()('goblin/workspace-plans/WorkspacePlans') {}
