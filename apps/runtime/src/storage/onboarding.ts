import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * First-run Start (ADR 0062): one row, written once the owner acts on it. `status` is `done` or `skipped` once the owner
 * said so, `open` until then. `steps` is a JSON array of the steps the owner went through; an id an older Start had is
 * ignored.
 */
export const appOnboarding = sqliteTable('app_onboarding', {
  id: integer('id').primaryKey().notNull(),
  status: text('status').notNull(),
  steps: text('steps').notNull(),
  kickoffAt: integer('kickoff_at'),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * A sign-in Start sent the owner to (ADR 0062), by connection: the step to come back to. Taken by the sign-in's
 * callback; an old one is ignored. `recommend` is no longer read (Start allows nothing on the way) and is written as 0
 * until the migrations are squashed.
 */
export const appOnboardingConnects = sqliteTable('app_onboarding_connects', {
  connectionId: text('connection_id').primaryKey().notNull(),
  step: text('step').notNull(),
  recommend: integer('recommend').notNull(),
  createdAt: integer('created_at').notNull(),
})
