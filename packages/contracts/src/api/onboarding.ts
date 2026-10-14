import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ConnectStart } from '../mcp.ts'
import { OnboardingChange, OnboardingConnect, OnboardingView } from '../onboarding.ts'
import { ApiErrors } from './errors.ts'

/**
 * First-run Start (ADR 0062). Paths are relative to the API's `/api` prefix.
 *
 * - `view`: `GET /api/onboarding`, every step's state, read from the agent alone (no server is asked).
 * - `change`: `PUT /api/onboarding`, the owner finishes or skips Start, goes through a step, or sends the kickoff.
 * - `connect`: `POST /api/onboarding/connect`, a sign-in that comes back to Start's step; answered as
 *   `POST /api/mcp/:id/connect` is.
 */
export class OnboardingGroup extends HttpApiGroup.make('onboarding').add(
  HttpApiEndpoint.get('view', '/onboarding', { success: OnboardingView }),
  HttpApiEndpoint.put('change', '/onboarding', { payload: OnboardingChange, success: OnboardingView }),
  HttpApiEndpoint.post('connect', '/onboarding/connect', {
    payload: OnboardingConnect,
    success: ConnectStart,
    error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.upstream, ApiErrors.upstreamTimeout],
  }),
) {}
