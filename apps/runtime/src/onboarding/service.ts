import type { OnboardingChange, OnboardingStep } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { OnboardingRecord } from './store.ts'

/** What the owner did with first-run Start (ADR 0062), kept by the agent. */
export class Onboarding extends Context.Service<
  Onboarding,
  {
    /** The stored record; none until the owner acted on Start. */
    readonly read: Effect.Effect<OnboardingRecord | undefined>
    /** Applies the owner's change at `now` (epoch seconds). */
    readonly change: (change: OnboardingChange, now: number) => Effect.Effect<OnboardingRecord, AppError>
    /** Notes a sign-in Start sent the owner to from `step`, to come back to it. */
    readonly noteConnect: (connectionId: string, step: OnboardingStep, now: number) => Effect.Effect<void, AppError>
    /** Takes that note's step when the sign-in comes back; none for a sign-in Start did not begin. */
    readonly takeConnect: (connectionId: string, now: number) => Effect.Effect<OnboardingStep | undefined, AppError>
  }
>()('goblin/onboarding/Onboarding') {}
