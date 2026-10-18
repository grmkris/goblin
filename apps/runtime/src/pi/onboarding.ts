import { GenerationTask, defineExtension, hook } from '@earendil-works/pi-durable'
import { onboardingContext } from '../onboarding/program.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { withContext } from './context-tail.ts'

/**
 * First-run Start (ADR 0079): right after the kickoff, the reminder to begin useful work joins the kickoff channel's
 * context block before each request (for that request only, never the transcript). A failure, or no reminder,
 * leaves the request as it was.
 */
export function onboardingExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.onboarding',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          // expected: setup's note is optional; a request without it is the turn as it was, and run reported anything unexpected
          const text = await run(onboardingContext(String(api.conversationId))).catch(() => undefined)
          return text === undefined ? undefined : { messages: withContext(messages, 'onboarding', text) }
        },
      }),
    ],
  })
}
