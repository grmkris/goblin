import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ConversationUpdated, TopicView, runInput } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { toAppError } from '../../src/http/errors.ts'
import { type EventClient, pollEvents, secretAad, subscribeEvents } from '../../src/mcp/events/client.ts'
import { EventsListResult, EventsPollResult } from '../../src/mcp/events/protocol.ts'
import type { SqliteEventStore, Subscription } from '../../src/mcp/events/store.ts'
import { decodeEnvelope, verifyWebhook } from '../../src/mcp/events/webhook.ts'
import { CredentialCipher } from '../../src/mcp/oauth/cipher.ts'
import { fake } from '../fake.ts'
import { callOwner } from '../owner-client.ts'
import {
  type Person,
  type Server,
  asServer,
  call,
  holding,
  lever,
  person,
  scriptApp,
  showing,
  signedIn,
} from './owner-requests.ts'
import type { Received } from './publish-receiver.ts'
import { waitFor } from './until.ts'

const NAME = 'conversation.updated'
const RECEIVER = 'https://receiver.example.com/hooks'
const FROM_START = '0'.repeat(16)
/** The consumer's own credential key: it seals the secrets it subscribes with, as goblin's agent does. */
const CONSUMER_KEY = 'Y29uc3VtZXItdGVzdC1maXh0dXJlLWtleSEhISEhISE='

const Polled = Schema.Struct({
  events: Schema.Array(Schema.Struct({ eventId: Schema.String, data: ConversationUpdated, cursor: Schema.String })),
  cursor: Schema.String,
  hasMore: Schema.Boolean,
})

/** The room a server makes: its Topic's Conversation. */
async function roomOf(base: string, server: Server, name: string): Promise<string> {
  const made = await asServer(base, server, 'POST', '/api/topics', { name, operationId: `publish:${name}` })
  expect(made.status, await made.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(TopicView)(await made.json()).conversation
}

/** goblin's own MCP client of /mcp, as an installed app holding `token`. */
async function mcpAs(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'publish-conformance', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch: (input, init) => {
        const sent = new Headers(init?.headers)
        sent.set('authorization', `Bearer ${token}`)
        sent.set('connection', 'close')
        return fetch(input, { ...init, headers: sent })
      },
    }),
  )
  return client
}

/**
 * goblin's own Events consumer (`mcp/events/client.ts`) over `mcp`, holding one lease of `conversation.updated` at
 * `url`: its requests and decoders as they go to any producer, a store that keeps that one lease in memory, and the
 * secret in plain words for checking what arrives.
 */
async function consumerOf(mcp: Client, url: string) {
  const cipher = await CredentialCipher.fromBase64(CONSUMER_KEY)
  const secret = `whsec_${btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))}`
  const id = crypto.randomUUID()
  const now = Date.now()
  let lease: Subscription = {
    id,
    connectionId: 'goblin-self',
    name: NAME,
    argumentsJson: '{}',
    endpoint: 'goblin-self',
    principal: 'publish-case',
    callbackUrl: url,
    remoteId: null,
    secret: await cipher.encrypt(secret, secretAad({ id, connectionId: 'goblin-self' })),
    previousSecret: null,
    graceUntil: null,
    cursor: null,
    refreshBefore: null,
    nextRefreshAt: now,
    nextPollAt: now,
    status: 'pending',
    lastError: null,
    lastReceiptAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const store = fake<SqliteEventStore>({
    get: (asked) => (asked === lease.id ? lease : undefined),
    patchLive: (_row, patch) => {
      lease = { ...lease, ...patch }
      return true
    },
  })
  const client: EventClient = {
    connections: fake<EventClient['connections']>({
      events: (_connection, method, params, schema) =>
        Effect.tryPromise({
          try: () => mcp.request({ method, params }, Schema.toStandardSchemaV1(schema)),
          catch: (cause) => toAppError(cause),
        }),
    }),
    store,
    cipher,
    principal: 'publish-case',
    callback: () => Effect.succeed(url),
    wake: () => Effect.void,
    authorize: () => Effect.void,
    connected: () => Effect.void,
  }
  return { client, secret, lease: () => lease }
}

/** Every webhook the harness's receiver took at `path`, oldest first. */
const receivedAt = async (base: string, who: Person, path: string): Promise<readonly Received[]> => {
  // SAFETY: the lever answers the receiver's own records (`publish-receiver.ts`).
  const all = (await (await lever(base, who, 'publish/received')).json()) as Received[]
  return all.filter((each) => new URL(each.url).pathname === path)
}

/** What a webhook says, checked as goblin's consumer checks one: its signature over the exact bytes, then its shape. */
async function verified(secret: string, each: Received) {
  const bytes = new TextEncoder().encode(each.body)
  const headers = { id: each.webhookId, timestamp: each.timestamp, signature: each.signature }
  await verifyWebhook(secret, headers, bytes, Date.now())
  return decodeEnvelope(bytes, each.webhookId)
}

/** The wakes among `received`: each occurrence's data. */
const wakesOf = (received: readonly Received[]) =>
  received.flatMap((each) => {
    const body: unknown = JSON.parse(each.body)
    const decoded = Schema.decodeUnknownOption(Schema.Struct({ data: ConversationUpdated }))(body)
    return Option.isSome(decoded) ? [{ ...decoded.value.data, at: each.at, webhookId: each.webhookId }] : []
  })

/** The controls of `type` among `received`. */
const controls = (received: readonly Received[], type: string) =>
  received.filter((each) => each.body.includes(`"type":"${type}"`))

/**
 * ADR 0112 on the real Worker and agent, and goblin's own Events consumer as the conformance check: an installed app
 * subscribes over /mcp with `mcp/events/client.ts`; the challenge, then a signed `conversation.updated` within about a
 * second of a message in its room, and an idle one when the turn ends; another app's room never reaches it; REST and
 * MCP polls agree and `null` answers where now is; a receiver that keeps failing is retried, then given a `gap`; and
 * uninstalling the app ends its leases with `terminated`.
 */
export async function publishCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  // The owner's own request gives the agent resident authority, which the rooms' turns need.
  await callOwner(me, (api) => api.personas.list({ query: {} }))
  const a = await scriptApp(url, owner, 'publish-a', { level: 'write', lists: true })
  const b = await scriptApp(url, owner, 'publish-b', { level: 'write', lists: true })
  const roomA = await roomOf(url, a, 'Customer A')
  const roomB = await roomOf(url, b, 'Customer B')

  // goblin's consumer subscribes to goblin, verified by the signed challenge.
  const mcp = await mcpAs(url, a.token)
  expect(mcp.getServerCapabilities()?.extensions).toHaveProperty(['io.modelcontextprotocol/events'])
  const listed = await mcp.request({ method: 'events/list', params: {} }, Schema.toStandardSchemaV1(EventsListResult))
  expect(listed.events.map(({ name, delivery }) => ({ name, delivery }))).toEqual([
    { name: NAME, delivery: ['poll', 'webhook'] },
  ])
  const consumer = await consumerOf(mcp, `${RECEIVER}/a`)
  const subscribed = await Effect.runPromise(subscribeEvents(consumer.client, consumer.lease()))
  expect(subscribed).toMatchObject({ status: 'active', remoteId: expect.stringMatching(/^sub_[0-9a-f]{64}$/u) })
  const [challenge] = await receivedAt(url, owner, '/hooks/a')
  if (challenge === undefined) throw new Error('no challenge')
  expect(await verified(consumer.secret, challenge)).toMatchObject({ type: 'verification' })

  // A message in its room: a signed wake within about a second, then an idle one when the turn ends.
  const sent = Date.now()
  await callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: roomA },
      payload: runInput(roomA, { input: 'queue-hold:publish-1', operationId: 'publish:own:1' }),
    }),
  )
  await holding(url, owner, 'queue-hold:publish-1')
  const working = await waitFor(
    async () => wakesOf(await receivedAt(url, owner, '/hooks/a')),
    (wakes) => wakes.some((wake) => wake.chat === roomA && wake.activity === 'working'),
    'a working wake',
    10_000,
  )
  const first = working.find((wake) => wake.chat === roomA)
  expect((first?.at ?? Number.POSITIVE_INFINITY) - sent).toBeLessThan(3000)
  await lever(url, owner, 'queue/release', { input: 'queue-hold:publish-1' })
  const idle = await waitFor(
    async () => wakesOf(await receivedAt(url, owner, '/hooks/a')),
    (wakes) => wakes.some((wake) => wake.chat === roomA && wake.activity === 'idle'),
    'an idle wake',
    10_000,
  )
  expect(idle.at(-1)).toMatchObject({ chat: roomA, activity: 'idle', attention: 0 })
  expect(idle.at(-1)?.entry).toBeGreaterThan(first?.entry ?? 0)
  for (const each of await receivedAt(url, owner, '/hooks/a')) {
    expect(each.subscriptionId).toBe(subscribed.remoteId)
    await verified(consumer.secret, each)
  }

  // Another app's room: the owner's poll sees its chat change; app A's deliveries and polls never do.
  const sentB = await asServer(
    url,
    b,
    'POST',
    `/api/conversations/${roomB}/messages`,
    runInput(roomB, { input: 'in room b', operationId: 'publish:b:1' }),
  )
  expect(sentB.status, await sentB.clone().text()).toBe(202)
  await showing(me, roomB, 'echo: in room b')
  const ownerPoll = async () =>
    Schema.decodeUnknownSync(Polled)(
      await (await call(url, owner, '/api/events/poll', { name: NAME, cursor: FROM_START })).json(),
    )
  await waitFor(ownerPoll, ({ events }) => events.some(({ data }) => data.chat === roomB), 'room B journaled', 10_000)

  // REST and MCP polls agree, and an app's reach no other room; a null cursor answers where now is.
  const rest = Schema.decodeUnknownSync(Polled)(
    await (await asServer(url, a, 'POST', '/api/events/poll', { name: NAME, cursor: FROM_START })).json(),
  )
  const viaMcp = await Effect.runPromise(pollEvents(consumer.client, { ...consumer.lease(), cursor: FROM_START }))
  expect(Schema.is(EventsPollResult)(viaMcp)).toBe(true)
  expect(viaMcp.events.map(({ eventId }) => eventId)).toEqual(rest.events.map(({ eventId }) => eventId))
  expect(rest.events.map(({ data }) => data.chat)).not.toContain(roomB)
  expect(rest.events.map(({ data }) => data.chat)).toContain(roomA)
  for (const wake of wakesOf(await receivedAt(url, owner, '/hooks/a'))) expect(wake.chat).not.toBe(roomB)
  const now = Schema.decodeUnknownSync(Polled)(
    await (await asServer(url, a, 'POST', '/api/events/poll', { name: NAME, cursor: null })).json(),
  )
  expect(now.events).toEqual([])
  expect(Number(now.cursor)).toBeGreaterThanOrEqual(Number(rest.cursor))

  // A receiver that keeps failing is tried again, then given up on with a gap.
  const failing = await consumerOf(mcp, `${RECEIVER}/failing`)
  await Effect.runPromise(subscribeEvents(failing.client, failing.lease()))
  await callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: roomA },
      payload: runInput(roomA, { input: 'once more', operationId: 'publish:own:2' }),
    }),
  )
  const tried = await waitFor(
    () => receivedAt(url, owner, '/hooks/failing'),
    (received) => controls(received, 'gap').length > 0,
    'a gap after the retries',
    60_000,
  )
  const attempts = tried.filter((each) => wakesOf([each]).length > 0)
  expect(attempts.length).toBeGreaterThanOrEqual(5)
  expect(attempts.every(({ status }) => status === 500)).toBe(true)
  const [gap] = controls(tried, 'gap')
  if (gap === undefined) throw new Error('no gap')
  expect(await verified(failing.secret, gap)).toMatchObject({ type: 'gap', cursor: expect.stringMatching(/^\d{16}$/u) })

  // Uninstalling the app ends its leases: each is sent `terminated` before the app stops admitting.
  const revoked = await me.fetch(
    new Request(`https://goblin.test/api/installations/${a.installationId}`, { method: 'DELETE' }),
  )
  expect(revoked.status, await revoked.clone().text()).toBe(200)
  const ended = await waitFor(
    () => receivedAt(url, owner, '/hooks/a'),
    (received) => controls(received, 'terminated').length > 0,
    'a terminated control',
    10_000,
  )
  const [terminated] = controls(ended, 'terminated')
  if (terminated === undefined) throw new Error('no termination')
  expect(await verified(consumer.secret, terminated)).toMatchObject({
    type: 'terminated',
    error: { code: -32012 },
  })
  await mcp.close()
}
