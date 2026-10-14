import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget } from '../src/budget.ts'
import { type AppError, BudgetExhausted, Internal, ResidentInactive } from '../src/http/errors.ts'
import { Resident } from '../src/mcp/service.ts'
import { admissionSkip } from '../src/routines/runner.ts'
import { fake } from './fake.ts'

/** Admission's verdict when resident authority and today's budget answer as given. */
const skipOf = (
  answers: {
    readonly resident?: Effect.Effect<void, AppError>
    readonly budget?: Effect.Effect<void, AppError>
  } = {},
) =>
  admissionSkip.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Resident, fake<typeof Resident.Service>({ require: () => answers.resident ?? Effect.void })),
        Layer.succeed(Budget, fake<typeof Budget.Service>({ require: () => answers.budget ?? Effect.void })),
      ),
    ),
  )

describe('routine admission (R3)', () => {
  it.effect('runs a firing resident authority and the budget allow', () =>
    Effect.gen(function* () {
      expect(yield* skipOf()).toBeUndefined()
    }),
  )

  it.effect('records a firing as skipped, by its reason, only when one of those refuses it', () =>
    Effect.gen(function* () {
      expect(yield* skipOf({ resident: Effect.fail(new ResidentInactive({ state: 'revoked' })) })).toBe(
        'ResidentInactive',
      )
      expect(yield* skipOf({ budget: Effect.fail(new BudgetExhausted({ limit: 800, resetsAt: 86_400 })) })).toBe(
        'BudgetExhausted',
      )
    }),
  )

  it.effect('fails the admission when storage fails, instead of skipping the firing', () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        skipOf({ budget: Effect.fail(new Internal({ reason: 'usage storage unavailable' })) }),
      )
      expect(failed).toMatchObject({ _tag: 'Internal' })
    }),
  )
})
