import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import { mcpHost } from '../../src/mcp/connections/host.ts'
import { deliverNoticeCopies } from '../../src/notices/copies.ts'
import { Notices } from '../../src/notices/service.ts'
import { NoticeStore } from '../../src/notices/store.ts'
import { enableResident } from '../../src/resident.ts'
import { noticesOf } from '../../src/layers/routines.ts'
import { ResidentLive } from '../../src/layers/core.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { Db } from '../../src/runtime/db.ts'
import type { AppError } from '../../src/http/errors.ts'
import type { Resident as ResidentService } from '../../src/mcp/service.ts'
import { AgentInput, type AgentInputs } from '../../src/runtime/input.ts'

/** What the dispatch check reads. */
type LaneServices = ResidentService | Db
import { MemoryCredentials, MemoryGrants, MemoryLabels, MemoryRegistries } from '../mcp/memory.ts'
import { appNotices } from '../../src/storage/notices.ts'
import { appNotifySink } from '../../src/storage/sources.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { lowLevelServer } from '../mcp/low-level-server.ts'
import { type Probes, inAgent } from './probe.ts'

function notificationHandler(calls: Record<string, unknown>[]) {
  return createMcpHandler(() => {
    const server = lowLevelServer({ name: 'notification-fixture', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({
      tools: ['inbox_read', 'message_send'].map((name) => ({ name, inputSchema: { type: 'object' as const } })),
    }))
    server.setRequestHandler('tools/call', (request) => {
      calls.push(request.params.arguments ?? {})
      return { content: [], structuredContent: { id: 'fixture-remote-id', delivery: 'accepted' } }
    })
    return server
  })
}

function notificationHost(
  credentials: MemoryCredentials,
  attempts: Record<string, unknown>[],
  accepted: Record<string, unknown>[],
) {
  const handler = notificationHandler(accepted)
  return mcpHost({
    servers: [{ connectionId: 'chat', endpoint: 'https://notification.test/mcp' }],
    appUrl: 'https://goblin.test',
    credentials,
    grants: new MemoryGrants([{ connectionId: 'chat', capability: 'tool', name: 'message_send' }]),
    registries: new MemoryRegistries(),
    labels: new MemoryLabels(),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST') {
        const body: { method?: string; params?: { arguments?: Record<string, unknown> } } = await request.clone().json()
        if (body.method === 'tools/call') {
          attempts.push(body.params?.arguments ?? {})
          if (attempts.length === 1) return new Response(null, { status: 503 })
        }
      }
      return handler.fetch(request)
    },
  })
}
async function setupNotifications(storage: DurableObjectStorage) {
  const db = drizzle(storage)
  const notices = new NoticeStore(db)
  enableResident(db, Math.floor(Date.now() / 1000))
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('chat', { access_token: 'keyless-fixture', token_type: 'bearer' }, 1)
  const attempts: Record<string, unknown>[] = []
  const accepted: Record<string, unknown>[] = []
  const host = notificationHost(credentials, attempts, accepted)
  // The services the copies read, over these instances as the agent's layers build them.
  const services = Layer.mergeAll(
    Layer.succeed(Notices, noticesOf(notices)),
    host.pipe(Layer.provide(SingleFlight.layer)),
    ResidentLive,
  ).pipe(Layer.provideMerge(Layer.succeed(Db, db)))
  db.insert(appNotifySink)
    .values({
      id: 1,
      connectionId: 'chat',
      tool: 'message_send',
      arguments: JSON.stringify({ chat: 'dm', text: '{{text}}', operationId: '{{operationId}}' }),
      policy: JSON.stringify({ result: { accepted: { pointer: '/delivery', equals: 'accepted' } } }),
      revision: '1',
      updatedAt: 1,
    })
    .run()
  // The bridge's `local`, which the copies run their last-moment check through, over the same services.
  const input: AgentInputs = Object.assign(Object.create(null), {
    local: (program: Effect.Effect<void, AppError, LaneServices>) =>
      Effect.runPromise(program.pipe(Effect.provide(services))),
  })
  const deliver = () =>
    Effect.runPromise(deliverNoticeCopies.pipe(Effect.provide(services), Effect.provideService(AgentInput, input)))
  return { db, notices, attempts, accepted, deliver }
}

/** A written notice of routine `id`, with a copy through Notify me via when `copy`. */
function writtenNotice(notices: NoticeStore, id: string, copy: boolean) {
  const at = Date.now()
  notices.claim(
    {
      id,
      routineId: `rt_${id}`,
      source: 'event',
      chatId: '1',
      entryRequestId: id,
      connectionId: 'sidequest',
      label: 'Sidequest',
      title: 'Picked <safe>',
      body: null,
      url: null,
      at,
      createdAt: at,
      ...(copy ? { copyText: 'Sidequest: Picked <safe>' } : {}),
    },
    true,
  )
  notices.written(id, at)
  return id
}

/** Native SQLite outbox and official SDK; all sends remain in the injected fixture. */
async function routineNotificationProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const { db, notices, attempts, accepted, deliver } = await setupNotifications(storage)
  writtenNotice(notices, 'notice-off', false)
  await deliver()
  const offCalls = attempts.length
  const on = writtenNotice(notices, 'notice-on', true)
  await deliver()
  const failed = notices.get(on)
  db.update(appNotices).set({ copyNextAt: 0 }).where(eq(appNotices.id, on)).run()
  await deliver()
  const delivered = notices.get(on)
  await deliver()
  return {
    offCalls,
    frozenSink: failed?.copySink?.includes(':1:') === true,
    retryState: failed?.copyState,
    attempts: attempts.length,
    stableBytes: JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]),
    sent: { chat: attempts[0]?.['chat'], text: attempts[0]?.['text'] },
    accepted: accepted.length,
    state: delivered?.copyState,
    metadata: JSON.parse(delivered?.copyReceipt ?? '{}'),
  }
}

export const probes: Probes = {
  'routine-notifications': inAgent(({ storage }) => routineNotificationProbe(storage)),
}
