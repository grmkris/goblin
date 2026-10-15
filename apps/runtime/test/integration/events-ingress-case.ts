import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import { type AgentFetch, deliverEvents } from '../../src/inbound/client.ts'
import type { EventWebhook } from '../../src/mcp/events.ts'
import { revokeResident } from '../../src/resident.ts'
import { type Probes, inAgent } from './probe.ts'

/** A webhook for a subscription the agent does not know: ingress answers it from the authority checks alone. */
const WEBHOOK: EventWebhook = {
  connectionId: 'mygram',
  body: new Uint8Array(),
  subscriptionId: 'remote-transient',
  id: 'evt_transient',
  timestamp: '0',
  signature: '',
}

/** The status the agent answered the webhook with, as the Worker's Events route delivers it, or the failure's tag. */
const answer = (agent: AgentFetch): Promise<number | string> =>
  Effect.runPromise(
    deliverEvents(agent, WEBHOOK).pipe(
      Effect.map(({ status }) => status),
      // expected: the case answers the failure's tag, for the native test to assert on
      Effect.catch((error) => Effect.succeed(error._tag)),
    ),
  )

/**
 * Events ingress (M1) on the native agent, through its internal API as the Worker's Events route reaches it. The
 * owner's own refusal (resident authority revoked) answers 410, which ends the subscription; it is decided before any
 * subscription row is read.
 */
async function eventsIngressCase(
  agent: AgentFetch,
  revoke: () => Promise<void>,
): Promise<{ readonly revoked: number | string }> {
  await revoke()
  return { revoked: await answer(agent) }
}

export const probes: Probes = {
  'events-ingress': inAgent(({ api, storage }) =>
    eventsIngressCase(api, async () => revokeResident(drizzle(storage), Math.floor(Date.now() / 1000))),
  ),
}
