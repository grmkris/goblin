import { GenerationTask, defineExtension, hook } from '@earendil-works/pi-durable'
import { onboardingContext } from '../onboarding/program.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { withContext } from './context-tail.ts'

/**
 * First-run Start in main (ADR 0062): right after the kickoff, the ask to propose Topics and Personas joins goblin's
 * context block before each request (for that request only, never the transcript). A failure, or nothing to ask,
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
