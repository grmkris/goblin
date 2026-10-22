import type { PersonaFailure, PersonaInvocationView } from '@goblin/contracts'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appPersonaInvocations } from '../storage/personas.ts'

type Row = typeof appPersonaInvocations.$inferSelect
type State = PersonaInvocationView['state']

const LIVE: readonly State[] = ['pending', 'running']

const view = (row: Row): PersonaInvocationView => ({
  operationId: row.operationId,
  persona: row.personaId,
  revision: row.revision,
  chat: row.chatId,
  order: row.ord,
  state: row.state,
  ...(row.fork === null ? {} : { fork: row.fork }),
  ...(row.answerEntry === null ? {} : { answerEntry: row.answerEntry }),
  ...(row.reason === null ? {} : { reason: row.reason }),
  createdAt: row.createdAt,
  ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
})

/** How an invocation settles: answered with its entry, failed with why (ADR 0083), or stopped by the owner. */
export type Settlement =
  | { readonly state: 'answered'; readonly entry: number }
  | { readonly state: 'failed'; readonly reason: PersonaFailure }
  | { readonly state: 'stopped' }

/** The columns a settlement writes. */
const settled = (settlement: Settlement, now: number) => {
  if (settlement.state === 'answered') return { state: settlement.state, answerEntry: settlement.entry, settledAt: now }
  if (settlement.state === 'failed') return { state: settlement.state, reason: settlement.reason, settledAt: now }
  return { state: settlement.state, settledAt: now }
}

/** One tagged Persona on one owner message, as the registry of Persona turns keeps it. */
export type NewInvocation = {
  readonly operationId: string
  readonly persona: number
  readonly revision: number
  readonly chat: string
  readonly order: number
}

/**
 * Which Persona answers which owner message, and how far it got (ADR 0033), as rows: a store with no state of its own
 * (the Invocations service tells the change bus). The row is the owner-visible state; the `goblin.persona-turn` task in
 * Pi does the work and reports into it. A settled row never moves again, so a replayed step or a Stop after the answer
 * changes nothing. Each write answers the invocations it changed.
 */
export class PersonaInvocations<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>) {
    this.#db = db
  }

  /** Records the tagged Personas of one send, once per operation and Persona. */
  insert(invocations: readonly NewInvocation[], now: number): readonly PersonaInvocationView[] {
    const rows = this.#db.transaction(() =>
      invocations.flatMap((each) =>
        this.#db
          .insert(appPersonaInvocations)
          .values({
            operationId: each.operationId,
            personaId: each.persona,
            revision: each.revision,
            chatId: each.chat,
            ord: each.order,
            state: 'pending',
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning()
          .all(),
      ),
    )
    return rows.map(view)
  }

  get(operationId: string, persona: number): PersonaInvocationView | undefined {
    const row = this.#db
      .select()
      .from(appPersonaInvocations)
      .where(and(eq(appPersonaInvocations.operationId, operationId), eq(appPersonaInvocations.personaId, persona)))
      .get()
    return row === undefined ? undefined : view(row)
  }

  /** The invocations not settled yet, oldest first: what a reload still shows as answering. */
  live(): readonly PersonaInvocationView[] {
    return this.#db
      .select()
      .from(appPersonaInvocations)
      .where(inArray(appPersonaInvocations.state, [...LIVE]))
      .orderBy(asc(appPersonaInvocations.createdAt), asc(appPersonaInvocations.ord))
      .all()
      .map(view)
  }

  /** The invocations working in `chat` now, each in its fork: what the chat's stream follows. */
  working(chat: string): readonly PersonaInvocationView[] {
    return this.#db
      .select()
      .from(appPersonaInvocations)
      .where(and(eq(appPersonaInvocations.chatId, chat), eq(appPersonaInvocations.state, 'running')))
      .orderBy(asc(appPersonaInvocations.createdAt), asc(appPersonaInvocations.ord))
      .all()
      .map(view)
      .filter((each) => each.fork !== undefined)
  }

  /** The newest invocations asked in `chat`, newest first: what a server reading the chat sees settle (ADR 0081). */
  ofChat(chat: string, limit: number): readonly PersonaInvocationView[] {
    return this.#db
      .select()
      .from(appPersonaInvocations)
      .where(eq(appPersonaInvocations.chatId, chat))
      .orderBy(desc(appPersonaInvocations.createdAt), desc(appPersonaInvocations.ord))
      .limit(limit)
      .all()
      .map(view)
  }

  /** Every invocation of one send, in order. */
  of(operationId: string): readonly PersonaInvocationView[] {
    return this.#db
      .select()
      .from(appPersonaInvocations)
      .where(eq(appPersonaInvocations.operationId, operationId))
      .orderBy(asc(appPersonaInvocations.ord))
      .all()
      .map(view)
  }

  /** The Persona started working in its chat `fork`. Only a pending invocation moves. */
  running(operationId: string, persona: number, fork: string): readonly PersonaInvocationView[] {
    return this.#db
      .update(appPersonaInvocations)
      .set({ state: 'running', fork })
      .where(
        and(
          eq(appPersonaInvocations.operationId, operationId),
          eq(appPersonaInvocations.personaId, persona),
          eq(appPersonaInvocations.state, 'pending'),
        ),
      )
      .returning()
      .all()
      .map(view)
  }

  /** Settles one invocation; a settled one stays as it is. */
  settle(operationId: string, persona: number, settlement: Settlement, now: number): readonly PersonaInvocationView[] {
    return this.#db
      .update(appPersonaInvocations)
      .set(settled(settlement, now))
      .where(
        and(
          eq(appPersonaInvocations.operationId, operationId),
          eq(appPersonaInvocations.personaId, persona),
          inArray(appPersonaInvocations.state, [...LIVE]),
        ),
      )
      .returning()
      .all()
      .map(view)
  }

  /** Stops every unsettled invocation in `chat`: the owner's Stop. */
  stopChat(chat: string, now: number): readonly PersonaInvocationView[] {
    return this.#db
      .update(appPersonaInvocations)
      .set({ state: 'stopped', settledAt: now })
      .where(and(eq(appPersonaInvocations.chatId, chat), inArray(appPersonaInvocations.state, [...LIVE])))
      .returning()
      .all()
      .map(view)
  }
}
