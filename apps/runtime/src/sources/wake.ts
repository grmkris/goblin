import * as Effect from 'effect/Effect'
import { writeLine } from '../observability/logger.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { outcomeOf } from '../telemetry/attributes.ts'
import { expectedFailure } from '../telemetry/safety.ts'
import { Sources } from './service.ts'

// The Sources' alarm (ADR 0066), as the agent's schedule callback runs it: one program through the bridge's `run`, its
// failure reported as a content-free line.

/** One line when the alarm fails: the error's type, never message content. */
const reportWake = (error: unknown): void => {
  const tag = outcomeOf(error)
  writeLine(expectedFailure(tag) ? 'info' : 'warn', { event: 'wake', task: 'sources', 'error.type': tag })
}

/**
 * `sourcesWake`: each Source tended and the answers due sent, then the alarm again when something still waits (in
 * five minutes after a failure). Without resident authority nothing is read or sent, and nothing is scheduled: the
 * next event or the owner's next change wakes it.
 */
export async function sourcesWake(run: RunProgram, again: (seconds: number) => Promise<unknown>): Promise<void> {
  const next = await run(
    Sources.use((sources) => sources.wake).pipe(
      // expected: an agent without resident authority reads and sends nothing until it has it again.
      Effect.catchTag('ResidentInactive', () => Effect.succeed(undefined)),
    ),
  ).catch((error: unknown) => {
    reportWake(error)
    return 300
  })
  if (next !== undefined) await again(next)
}
