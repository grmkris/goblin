import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ConnectStart } from '../mcp.ts'
import {
  OnboardingChange,
  OnboardingConnect,
  OnboardingKickedOff,
  OnboardingKickoff,
  OnboardingView,
} from '../onboarding.ts'
import { ApiErrors } from './errors.ts'
import { EndpointRole } from './role.ts'

/**
 * First-run Start (ADR 0062). Paths are relative to the API's `/api` prefix.
 *
 * - `view`: `GET /api/onboarding`, every step's state, read from the agent alone (no server is asked).
 * - `change`: `PUT /api/onboarding`, the owner finishes or skips Start, or goes through a step.
 * - `kickoff`: `POST /api/onboarding/kickoff`, the owner's goal starts their first channel and finishes Start
 *   (ADR 0079).
 * - `connect`: `POST /api/onboarding/connect`, a sign-in that comes back to Start's step; answered as
 *   `POST /api/mcp/:id/connect` is.
 */
export class OnboardingGroup extends HttpApiGroup.make('onboarding').add(
  HttpApiEndpoint.get('view', '/onboarding', { success: OnboardingView }),
  HttpApiEndpoint.put('change', '/onboarding', { payload: OnboardingChange, success: OnboardingView }).annotate(
    EndpointRole,
    'admin',
  ),
  HttpApiEndpoint.post('kickoff', '/onboarding/kickoff', {
    payload: OnboardingKickoff,
    success: OnboardingKickedOff,
    error: [ApiErrors.conflict, ApiErrors.invalidInput, ApiErrors.notFound, ApiErrors.budgetExhausted],
  }).annotate(EndpointRole, 'admin'),
  HttpApiEndpoint.post('connect', '/onboarding/connect', {
    payload: OnboardingConnect,
    success: ConnectStart,
    error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.upstream, ApiErrors.upstreamTimeout],
  }).annotate(EndpointRole, 'admin'),
) {}
