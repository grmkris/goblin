import { WorkspacePlanView, WorkspacePlanProposal } from '@goblin/contracts'
import { desc, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { Conflict, NotFound } from '../http/errors.ts'
import { appWorkspacePlans } from '../storage/schema.ts'

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspacePlanView))

/** Immutable definitions and exact review snapshots, with progress updated synchronously. */
export class WorkspacePlanStore {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  get(id: string): WorkspacePlanView {
    const row = this.#db.select().from(appWorkspacePlans).where(eq(appWorkspacePlans.id, id)).get()
    if (row === undefined) throw new NotFound({ what: 'workspace plan' })
    return decode(row.review)
  }

  proposal(id: string): WorkspacePlanProposal {
    const row = this.#db.select().from(appWorkspacePlans).where(eq(appWorkspacePlans.id, id)).get()
    if (row === undefined) throw new NotFound({ what: 'workspace plan' })
    return Schema.decodeUnknownSync(Schema.fromJsonString(WorkspacePlanProposal))(row.definition)
  }

  list(): readonly WorkspacePlanView[] {
    return this.#db
      .select()
      .from(appWorkspacePlans)
      .orderBy(desc(appWorkspacePlans.createdAt))
      .limit(30)
      .all()
      .map((row) => decode(row.review))
  }

  begin(
    id: string,
    operationId: string,
    chat: string,
    proposal: WorkspacePlanProposal,
    now: number,
  ): WorkspacePlanView {
    const prior = this.#db.select().from(appWorkspacePlans).where(eq(appWorkspacePlans.operationId, operationId)).get()
    const definition = JSON.stringify(proposal)
    if (prior !== undefined) {
      if (prior.definition !== definition || prior.chatId !== chat)
        throw new Conflict({ reason: 'workspace_plan_operation' })
      return decode(prior.review)
    }
    const view: WorkspacePlanView = {
      id,
      chat,
      revision: 1,
      title: proposal.title,
      purpose: proposal.purpose,
      state: 'preparing',
      items: [],
      topics: [],
      completed: [],
      problem: null,
      continuation: 'pending',
      createdAt: now,
    }
    this.#db
      .insert(appWorkspacePlans)
      .values({ id, operationId, chatId: chat, definition, review: JSON.stringify(view), createdAt: now })
      .run()
    return view
  }

  save(view: WorkspacePlanView): WorkspacePlanView {
    this.#db
      .update(appWorkspacePlans)
      .set({ review: JSON.stringify(view) })
      .where(eq(appWorkspacePlans.id, view.id))
      .run()
    return view
  }
}
