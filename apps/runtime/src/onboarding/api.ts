import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { changeOnboarding, kickoff, onboardingView, startConnect } from './program.ts'

/** The `onboarding` group (ADR 0062): Start's whole view, the owner's changes, the kickoff and Start's sign-ins. */
export const OnboardingHandlers = HttpApiBuilder.group(OwnerApi, 'onboarding', (handlers) =>
  handlers
    .handle('view', () => onboardingView)
    .handle('change', ({ payload }) => changeOnboarding(payload))
    .handle('kickoff', ({ payload }) => kickoff(payload))
    .handle('connect', ({ payload }) => startConnect(payload)),
)
