import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { deliverEvents } from '../../src/inbound/client.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { CredentialStore } from '../../src/mcp/credentials.ts'
import { bindEndpoints } from '../../src/mcp/endpoints.ts'
import { AddedServerStore } from '../../src/mcp/servers.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import type { EventsFixture } from '../mcp/events-fixture.ts'
import type { AgentFetch } from '../owner-client.ts'

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='

/**
 * Connects the probe agent to the Events producer its MCP fetch reaches (`routine-events.test`, `worker.ts`) as
 * `connectionId`: a server the owner added, bound to its endpoint, with a keyless token, and the producer's webhooks
 * handed to the agent's internal API as the Worker's hook route hands them.
 */
export async function connectEventsServer(
  storage: DurableObjectStorage,
  agent: AgentFetch,
  fixture: EventsFixture,
  server: { readonly connectionId: string; readonly title: string },
) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const cipher = await CredentialCipher.fromBase64(KEY)
  const added = { ...server, endpoint: 'https://routine-events.test/mcp' }
  new AddedServerStore(db).add(added, 1)
  bindEndpoints(db, [added], 1)
  await new CredentialStore(db, cipher).saveTokens(
    server.connectionId,
    { access_token: 'keyless-fixture', token_type: 'bearer' },
    1,
  )
  fixture.receiver = async (request) => {
    const delivered = deliverEvents(agent, {
      connectionId: server.connectionId,
      body: new Uint8Array(await request.arrayBuffer()),
      id: request.headers.get('webhook-id') ?? '',
      timestamp: request.headers.get('webhook-timestamp') ?? '',
      signature: request.headers.get('webhook-signature') ?? '',
      subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
    })
    const result = await Effect.runPromiseExit(delivered)
    return Exit.isSuccess(result)
      ? new Response(result.value.response ?? null, { status: result.value.status })
      : new Response(null, { status: 400 })
  }
  return { db, cipher }
}
