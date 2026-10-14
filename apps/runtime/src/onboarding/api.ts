import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { changeOnboarding, onboardingView, startConnect } from './program.ts'

/** The `onboarding` group (ADR 0062): Start's whole view, the owner's changes and the sign-ins Start begins. */
export const OnboardingHandlers = HttpApiBuilder.group(OwnerApi, 'onboarding', (handlers) =>
  handlers
    .handle('view', () => onboardingView)
    .handle('change', ({ payload }) => changeOnboarding(payload))
    .handle('connect', ({ payload }) => startConnect(payload)),
)
