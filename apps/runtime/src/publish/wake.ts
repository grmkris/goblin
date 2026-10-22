import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { attempt } from '../http/errors.ts'
import { reportFailure } from '../observability/report.ts'
import { AgentInput } from '../runtime/input.ts'
import { Published } from './service.ts'

/** How long until a sweep that failed is tried again. */
const RETRY_MS = 60_000

/**
 * The published Events' alarm (`publishWake`, ADR 0112): one sweep, which arms the next alarm itself (`mcp/events/wake.ts`
 * is the pattern). A sweep that fails is reported and tried again in a minute, while something still waits.
 */
export const publishWake = Published.use((published) => published.maintain).pipe(
  reportFailure('publish.wake'),
  // expected: the sweep's failure was reported above; a minute on.
  Effect.catch(() =>
    Effect.gen(function* () {
      const due = yield* Published.use((published) => published.nextDue)
      if (due === undefined) return
      const now = yield* Clock.currentTimeMillis
      yield* AgentInput.use((input) => attempt(() => input.schedulePublish(Math.max(due, now + RETRY_MS))))
    }),
  ),
)
