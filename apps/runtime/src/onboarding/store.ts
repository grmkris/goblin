import { OnboardingStep, type OnboardingChange } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { appOnboarding, appOnboardingConnects } from '../storage/onboarding.ts'

/** Start's status once it is kept: the owner finished or skipped it. */
type KeptStatus = 'done' | 'skipped'

/**
 * What the owner did with Start: its kept status (none while it is open), the steps they went through, and when they
 * sent the kickoff.
 */
export type OnboardingRecord = {
  readonly status: KeptStatus | undefined
  readonly steps: readonly OnboardingStep[]
  readonly kickoffAt: number | undefined
  readonly kickoffChat: string | undefined
}

const decodeStrings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))
const isStep = Schema.is(OnboardingStep)

/** The steps a row records, leniently: an id Start no longer has (an older Start's) is dropped, never a failure. */
const stepsOf = (json: string): readonly OnboardingStep[] =>
  Option.match(decodeStrings(json), {
    onNone: () => [],
    onSome: (ids) => [...new Set(ids.filter(isStep))],
  })

/**
 * A sign-in noted longer ago than this (seconds) comes back to Connections, as any other does. An hour, as long as the
 * pending authorization lives.
 */
const CONNECT_FRESH = 60 * 60
/** `open` in the row is no kept status: Start is open. */
const decodeKept = Schema.decodeUnknownOption(Schema.Literals(['done', 'skipped']))

/** Start's one row (ADR 0062). Nothing is stored until the owner acts, so an untouched Start is open. */
export class OnboardingStore {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  get(): OnboardingRecord | undefined {
    const row = this.#db.select().from(appOnboarding).where(eq(appOnboarding.id, 1)).get()
    if (row === undefined) return undefined
    return {
      status: Option.getOrUndefined(decodeKept(row.status)),
      steps: stepsOf(row.steps),
      kickoffAt: row.kickoffAt ?? undefined,
      kickoffChat: row.kickoffChat ?? undefined,
    }
  }

  /**
   * Applies the owner's change in one statement: a status (`open` forgets the kept one, so Start is open again), a step
   * they went through (kept once), the kickoff's time (kept from the first). Only a status changes the status: a step
   * or the kickoff alone leaves it as it was.
   */
  apply(change: OnboardingChange, now: number): OnboardingRecord {
    const current = this.get()
    const steps = [...(current?.steps ?? [])]
    if (change.step !== undefined && !steps.includes(change.step)) steps.push(change.step)
    const status = change.status === undefined ? current?.status : change.status === 'open' ? undefined : change.status
    const next: OnboardingRecord = {
      status,
      steps,
      kickoffAt: current?.kickoffAt ?? (change.kickoff === true ? now : undefined),
      kickoffChat: current?.kickoffChat ?? change.kickoffChat,
    }
    const values = {
      status: next.status ?? 'open',
      steps: JSON.stringify(next.steps),
      kickoffAt: next.kickoffAt ?? null,
      kickoffChat: next.kickoffChat ?? null,
    }
    this.#db
      .insert(appOnboarding)
      .values({ id: 1, ...values, updatedAt: now })
      .onConflictDoUpdate({ target: appOnboarding.id, set: { ...values, updatedAt: now } })
      .run()
    return next
  }

  /** Notes that Start sent the owner to sign in to `connectionId` from `step`, replacing an earlier note for it. */
  noteConnect(connectionId: string, step: OnboardingStep, now: number): void {
    // `recommend` is a column no longer read (storage/onboarding.ts).
    const values = { step, recommend: 0, createdAt: now }
    this.#db
      .insert(appOnboardingConnects)
      .values({ connectionId, ...values })
      .onConflictDoUpdate({ target: appOnboardingConnects.connectionId, set: values })
      .run()
  }

  /**
   * Takes the note for `connectionId`, the step to come back to: it is gone afterwards, and none comes back for one
   * older than an hour or for a step Start no longer has.
   */
  takeConnect(connectionId: string, now: number): OnboardingStep | undefined {
    const row = this.#db
      .delete(appOnboardingConnects)
      .where(eq(appOnboardingConnects.connectionId, connectionId))
      .returning()
      .get()
    if (row === undefined || now - row.createdAt > CONNECT_FRESH) return undefined
    return isStep(row.step) ? row.step : undefined
  }
}
