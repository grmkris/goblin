import { mutationOptions } from '@tanstack/react-query'
import type { OnboardingChange, OnboardingConnect, OnboardingStep, OnboardingView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { owner } from '../lib/api.ts'

/** First-run Start (ADR 0062) on the owner API. Keys are `['onboarding', kind]`. */
export const onboardingKeys = {
  view: ['onboarding', 'view'] as const,
}

/** Every step's state, read from the agent alone. */
export const onboardingQuery = owner.apiQuery({
  queryKey: onboardingKeys.view,
  queryFn: (api) => api.onboarding.view(),
})

/** The step Start picks up from: the first one still to do, the welcome once all are done or before Start is read. */
export const firstOpenStep = (view: OnboardingView | undefined): OnboardingStep =>
  view?.steps.find((step) => !step.done)?.id ?? 'welcome'

/**
 * The steps Start's ways back count as left: none once the owner finished Start, and never the welcome or the kickoff,
 * which are no tasks to come back to.
 */
export const stepsLeft = (view: OnboardingView): OnboardingView['steps'] =>
  view.status === 'done' ? [] : view.steps.filter((step) => !step.done && step.id !== 'welcome' && step.id !== 'goblin')

/** The owner finishes or skips Start, goes through a step, or records the kickoff; the view follows. */
export const changeOnboardingMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: OnboardingChange) => api.onboarding.change({ payload: change }),
  }),
  onSuccess: (view, _change, _result, { client }) => {
    client.setQueryData(onboardingQuery.queryKey, view)
  },
})

/**
 * Adds a suggested server from Start's services step and signs in to it, back to that step; nothing is allowed on the
 * way. Answers the new connection with the authorization URL to send the owner to, or none when it connected at once.
 */
export const startAddMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, endpoint: string) =>
      Effect.flatMap(api.mcp.addServer({ payload: { endpoint } }), ({ connectionId }) => {
        const request: OnboardingConnect = { connectionId, step: 'services' }
        return Effect.map(api.onboarding.connect({ payload: request }), (started) => ({ ...started, connectionId }))
      }),
  }),
  onSuccess: (started, _endpoint, _result, { client }) =>
    started.authorizationUrl === undefined
      ? Promise.all([
          client.invalidateQueries({ queryKey: onboardingKeys.view }),
          client.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
        ])
      : undefined,
})
