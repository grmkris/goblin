import { useQuery } from '@tanstack/react-query'
import type { OnboardingState, OnboardingStep } from '@goblin/contracts'
import { type SessionState, useSession } from '../auth/hooks.ts'
import { signedInStartQuery } from './queries.ts'

/**
 * What the shell does with a page that waits for first-run Start (ADR 0048): `wait` (a splash, no app around it) until
 * that is known, `start` to send the owner to Start's first open step, or `show` the page.
 */
export type StartDecision =
  | { readonly kind: 'wait' }
  | { readonly kind: 'start'; readonly step: OnboardingStep }
  | { readonly kind: 'show' }

const WAIT: StartDecision = { kind: 'wait' }
const SHOW: StartDecision = { kind: 'show' }

/** What the decision reads: the page, the session and Start's state as the cache holds them now. */
export type StartInputs = {
  readonly gated: boolean
  readonly session: SessionState
  readonly start: { readonly data: OnboardingState | undefined; readonly failed: boolean }
}

/**
 * Signed out or unable to check, the page's own gate takes over; a Start state that cannot be read lets the owner in,
 * since Start is help, not a lock. An open Start comes first.
 */
export const decideStart = ({ gated, session, start }: StartInputs): StartDecision => {
  if (!gated) return SHOW
  if (session === 'checking') return WAIT
  if (session !== 'signed-in') return SHOW
  if (start.data === undefined) return start.failed ? SHOW : WAIT
  if (start.data.status === 'open') return { kind: 'start', step: start.data.step ?? 'welcome' }
  return SHOW
}

/**
 * Whether the page the shell is about to draw (`gated`: it waits for Start) may show (`decideStart`). Start's state is
 * read as soon as someone is signed in, on every page, so moving to a gated one later waits for nothing.
 */
export function useStartDecision(gated: boolean): StartDecision {
  const session = useSession().state
  const start = useQuery(signedInStartQuery(session === 'signed-in'))
  return decideStart({ gated, session, start: { data: start.data, failed: start.error !== null } })
}
