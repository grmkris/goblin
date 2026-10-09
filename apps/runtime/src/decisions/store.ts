import * as Context from 'effect/Context'
import { DecisionAction, type DecisionLabel, type DecisionProposal } from '@goblin/contracts'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { appDecisionLabels, appDecisionProposals } from '../storage/decision-schema.ts'

/** Private fence: the relevant Pi identity and optional evidence digest, never shown as product copy. */
export const DecisionFence = Schema.Struct({
  session: Schema.String,
  epoch: Schema.Number,
  evidence: Schema.optional(Schema.String),
})
export type DecisionFence = typeof DecisionFence.Type
const StoredPayload = Schema.Struct({ action: DecisionAction, fence: DecisionFence })
type Row = typeof appDecisionProposals.$inferSelect
export type StoredDecision = { readonly proposal: DecisionProposal; readonly fence: DecisionFence }
export interface ProposalStore {
  get(id: string): StoredDecision | undefined
  list(): readonly DecisionProposal[]
  add(proposal: DecisionProposal, fence: DecisionFence): DecisionProposal
  decide(id: string, label: DecisionLabel['label'], now: number): DecisionProposal | undefined
  stale(id: string, now: number): DecisionProposal | undefined
}
const view = (row: Row): StoredDecision => {
  const data = Schema.decodeUnknownSync(Schema.fromJsonString(StoredPayload))(row.payload)
  const { payload: _payload, decidedAt, ...fields } = row
  return {
    fence: data.fence,
    proposal: { ...fields, payload: data.action, ...(decidedAt === null ? {} : { decidedAt }) },
  }
}
export class DecisionStore implements ProposalStore {
  readonly #db: DrizzleSqliteDODatabase
  readonly #listeners = new Set<(proposal: DecisionProposal) => void>()
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }
  onChange(listener: (proposal: DecisionProposal) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  #emit(proposal: DecisionProposal | undefined): void {
    if (proposal !== undefined) for (const listener of this.#listeners) listener(proposal)
  }
  get(id: string): StoredDecision | undefined {
    const row = this.#db.select().from(appDecisionProposals).where(eq(appDecisionProposals.id, id)).get()
    return row === undefined ? undefined : view(row)
  }
  list(): readonly DecisionProposal[] {
    return this.#db
      .select()
      .from(appDecisionProposals)
      .where(inArray(appDecisionProposals.state, ['open', 'confirmed']))
      .orderBy(asc(appDecisionProposals.createdAt))
      .limit(100)
      .all()
      .map((row) => view(row).proposal)
  }
  add(proposal: DecisionProposal, fence: DecisionFence): DecisionProposal {
    const inserted = this.#db
      .insert(appDecisionProposals)
      .values({
        ...proposal,
        payload: JSON.stringify({ action: proposal.payload, fence }),
      })
      .onConflictDoNothing()
      .returning()
      .get()
    const current = inserted === undefined ? this.get(proposal.id)?.proposal : view(inserted).proposal
    this.#emit(inserted === undefined ? undefined : current)
    return current ?? proposal
  }
  decide(id: string, label: DecisionLabel['label'], now: number): DecisionProposal | undefined {
    const changed = this.#db.transaction(() => {
      const row = this.#db
        .update(appDecisionProposals)
        .set({ state: label === 'confirm' ? 'confirmed' : 'dismissed', decidedAt: now })
        .where(and(eq(appDecisionProposals.id, id), eq(appDecisionProposals.state, 'open')))
        .returning()
        .get()
      if (row === undefined) return undefined
      this.#db
        .insert(appDecisionLabels)
        .values({
          proposalId: id,
          label,
          judgedAt: now,
          kind: row.kind,
          provider: row.provider,
          probability: row.probability,
        })
        .onConflictDoNothing()
        .run()
      return view(row).proposal
    })
    this.#emit(changed)
    return changed ?? this.get(id)?.proposal
  }
  stale(id: string, now: number): DecisionProposal | undefined {
    const row = this.#db
      .update(appDecisionProposals)
      .set({ state: 'stale', decidedAt: now })
      .where(and(eq(appDecisionProposals.id, id), eq(appDecisionProposals.state, 'open')))
      .returning()
      .get()
    const proposal = row === undefined ? undefined : view(row).proposal
    this.#emit(proposal)
    return proposal ?? this.get(id)?.proposal
  }
}

export class Proposals extends Context.Service<Proposals, DecisionStore>()('goblin/Proposals') {}
