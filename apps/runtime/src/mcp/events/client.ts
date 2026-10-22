import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  type AppError,
  Conflict,
  GrantDenied,
  InvalidInput,
  UpstreamMcp,
  attempt,
  attemptSync,
} from '../../http/errors.ts'
import type { CredentialCipher } from '../oauth/cipher.ts'
import type { McpConnections } from '../service.ts'
import { canonicalArguments, EVENT_LIMITS, type SqliteEventStore, type Subscription } from './store.ts'
import {
  EventsListResult,
  EventsPollResult,
  EventsSubscribeResult,
  EventsUnsubscribeResult,
  type EventDescriptor,
} from './protocol.ts'

const Arguments = Schema.Record(Schema.String, Schema.Unknown)
export const decodeArguments = (value: string): Record<string, unknown> =>
  Schema.decodeUnknownSync(Arguments)(JSON.parse(value))
/** A row's stored selector arguments, decoded. */
const argumentsOf = (row: Pick<Subscription, 'argumentsJson'>) => attemptSync(() => decodeArguments(row.argumentsJson))
export const secretAad = (row: Pick<Subscription, 'id' | 'connectionId'>): string =>
  `events:${row.connectionId}:${row.id}:secret`
export const envelopeAad = (row: Pick<Subscription, 'id' | 'connectionId'>, webhookId: string): string =>
  `events:${row.connectionId}:${row.id}:delivery:${webhookId}`
const makeSecret = (): string => `whsec_${btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))}`
const makeSubscriptionId = (): string => crypto.randomUUID()
const generationOf = (callback: string): string => {
  const url = new URL(callback)
  url.searchParams.set('goblin_generation', crypto.randomUUID())
  return url.toString()
}
const callbackBase = (callback: string): string => {
  const url = new URL(callback)
  url.searchParams.delete('goblin_generation')
  return url.toString()
}

/** What the Events requests go through: the connections, the durable intents and the agent's own identity. */
export type EventClient = {
  readonly connections: Pick<McpConnections['Service'], 'events' | 'server'>
  readonly store: SqliteEventStore
  readonly cipher: CredentialCipher
  readonly principal: string
  /** The webhook URL of `connectionId`'s Events (one per connection, ADR 0041). */
  readonly callback: (connectionId: string) => Effect.Effect<string>
  /** Arms the Events alarm no later than `at`. */
  readonly wake: (at: number) => Effect.Effect<void, AppError>
  /** The Events authority for one selector: checked before each request connects and again before it is sent. */
  readonly authorize: (connectionId: string, name: string, argumentsJson: string) => Effect.Effect<void, AppError>
  /** The authority to read a connection's catalog: the plan, resident authority and a signed-in connection, no grant. */
  readonly connected: (connectionId: string) => Effect.Effect<void, AppError>
}

/** One Events request for `row`'s selector, through its server's connection. */
const request = <S extends Schema.ConstraintDecoder<unknown>>(input: {
  readonly client: EventClient
  readonly row: Pick<Subscription, 'connectionId' | 'name' | 'argumentsJson'>
  readonly method: 'events/list' | 'events/poll' | 'events/subscribe' | 'events/unsubscribe'
  readonly params: Record<string, unknown>
  readonly schema: S
  readonly guard?: Effect.Effect<void, AppError>
}) =>
  input.client.connections.events(
    input.row.connectionId,
    input.method,
    input.params,
    input.schema,
    Effect.andThen(
      input.client.authorize(input.row.connectionId, input.row.name, input.row.argumentsJson),
      input.guard ?? Effect.void,
    ),
  )

/** Connection/credential waits cannot send work for a lease that was retired or replaced meanwhile. */
const currentLease = (client: EventClient, row: Subscription) =>
  Effect.suspend(() => {
    const current = client.store.get(row.id)
    return current?.secret === row.secret && current.status !== 'tombstone' && current.status !== 'terminated'
      ? Effect.void
      : Effect.fail(new Conflict({ reason: 'event lease changed' }))
  })

/** Every page of a connection's `events/list` under `authorize`, up to the page bound. */
const pagesOf = (client: EventClient, connectionId: string, authorize: Effect.Effect<void, AppError>) =>
  Effect.gen(function* () {
    const events: EventDescriptor[] = []
    let cursor: string | undefined
    for (let page = 0; page < EVENT_LIMITS.listPages; page++) {
      const params = cursor === undefined ? {} : { cursor }
      const result = yield* client.connections.events(connectionId, 'events/list', params, EventsListResult, authorize)
      events.push(...result.events)
      if (result.nextCursor === undefined || result.nextCursor === cursor) return events
      cursor = result.nextCursor
    }
    return yield* new UpstreamMcp({ connectionId, reason: 'content-limit' })
  })

/** The server's event descriptors, read for one granted selector before it is subscribed. */
export const listEvents = (client: EventClient, connectionId: string, name: string, args: Record<string, unknown>) =>
  Effect.flatMap(
    attemptSync(() => canonicalArguments(args)),
    (argumentsJson) => pagesOf(client, connectionId, client.authorize(connectionId, name, argumentsJson)),
  )

/** The server's event descriptors as the owner browses them: no selector grant is needed, and none is made. */
export const catalogEvents = (client: EventClient, connectionId: string) =>
  pagesOf(client, connectionId, client.connected(connectionId))

/** The durable intent for a selector, made (or found current) before anything is sent: a finite lease to come. */
export const prepareEvents = (
  client: EventClient,
  connectionId: string,
  name: string,
  args: Record<string, unknown>,
  ttlMs: number = EVENT_LIMITS.ttlMs,
) =>
  Effect.gen(function* () {
    const { store, principal, cipher } = client
    const argumentsJson = yield* attemptSync(() => canonicalArguments(args))
    if (!store.allows(connectionId, name, argumentsJson)) return yield* new GrantDenied({ connectionId, name })
    const { endpoint } = yield* client.connections.server(connectionId)
    const callback = yield* client.callback(connectionId)
    const current = store.selector(connectionId, name, argumentsJson)
    const now = yield* Clock.currentTimeMillis
    if (
      current !== undefined &&
      current.endpoint === endpoint &&
      current.principal === principal &&
      callbackBase(current.callbackUrl) === callbackBase(callback) &&
      current.status !== 'tombstone' &&
      current.status !== 'terminated'
    )
      return current
    if (store.count() >= EVENT_LIMITS.subscriptions && (current === undefined || current.status === 'tombstone'))
      return yield* new InvalidInput({ reason: 'too many event subscriptions' })
    const binding = { id: current?.id ?? (yield* Effect.sync(makeSubscriptionId)), connectionId }
    const generationCallback = yield* attemptSync(() => generationOf(callback))
    const secret = yield* attempt(() => cipher.encrypt(makeSecret(), secretAad(binding)))
    const row: Subscription = {
      ...binding,
      name,
      argumentsJson,
      endpoint,
      principal,
      callbackUrl: generationCallback,
      remoteId: null,
      secret,
      previousSecret: null,
      graceUntil: null,
      cursor: null,
      refreshBefore: null,
      nextRefreshAt: now,
      nextPollAt: now + 300_000,
      status: 'pending',
      lastError: null,
      lastReceiptAt: null,
      createdAt: now,
      updatedAt: now,
    }
    // Arm a recovery wake before the durable intent. A crash after commit is repaired by this alarm or startup.
    yield* client.wake(now + Math.min(ttlMs, 60_000))
    if (!(yield* Effect.sync(() => store.savePrepared(row, current))))
      return yield* new Conflict({ reason: 'event lease changed' })
    return row
  })

/** A lease the server answered truncated, or with its delivery inactive, catches up by polling before it is active. */
const leaseStatus = (result: EventsSubscribeResult): 'catching_up' | 'active' =>
  result.truncated === true || result.deliveryStatus?.active === false ? 'catching_up' : 'active'

/**
 * A fresh generation of `row`'s lease, saved over it while it is still the current one: a new callback generation and
 * secret, no remote id yet, its cursor kept, so a subscribe of it reaches whatever now answers the selector. Queued
 * deliveries of the old generation are finished, as any replacement's are (ADR 0073).
 */
const freshGeneration = (client: EventClient, row: Subscription) =>
  Effect.gen(function* () {
    const current = client.store.get(row.id)
    if (current?.secret !== row.secret || current.status === 'tombstone' || current.status === 'terminated')
      return yield* new Conflict({ reason: 'event lease changed' })
    const now = yield* Clock.currentTimeMillis
    const callbackUrl = yield* attemptSync(() => generationOf(current.callbackUrl))
    const secret = yield* attempt(() => client.cipher.encrypt(makeSecret(), secretAad(current)))
    const fresh: Subscription = {
      ...current,
      callbackUrl,
      secret,
      previousSecret: null,
      graceUntil: null,
      remoteId: null,
      refreshBefore: null,
      nextRefreshAt: now,
      status: 'pending',
      lastError: null,
      updatedAt: now,
    }
    // Arm a recovery wake before the durable intent, as a prepared lease does.
    yield* client.wake(now + 60_000)
    if (!(yield* Effect.sync(() => client.store.savePrepared(fresh, current))))
      return yield* new Conflict({ reason: 'event lease changed' })
    return fresh
  })

/**
 * Subscribes (or renews) `row` remotely and records the lease, refreshed 10% early with bounded jitter. A renewal the
 * server answers with another subscription id means the lease behind this callback URL is no longer the one goblin
 * holds (a gateway that now reaches the app through another of the owner's accounts, ADR 0096): goblin subscribes a
 * fresh generation, so its own callback URL tells it apart, then unsubscribes the old generation by its exact name,
 * arguments and URL, best effort. Whatever that cannot reach lapses with its finite lease. A second change of id in the
 * same renewal is the server's error.
 */
export const subscribeEvents = (
  client: EventClient,
  row: Subscription,
  ttlMs: number = EVENT_LIMITS.ttlMs,
): Effect.Effect<Subscription, AppError> => subscribeLease(client, row, ttlMs, false)

/** Whether the server answered `row`'s subscribe with an id other than the one it already has. */
const idChanged = (store: SqliteEventStore, row: Subscription, id: string): boolean => {
  const known = store.get(row.id)?.remoteId
  return known !== null && known !== undefined && known !== id
}

/**
 * A fresh generation subscribed in place of `row`, then `row`'s own lease ended by its exact selector and URL; while
 * `replacing` already, the server's error.
 */
const movedLease = (client: EventClient, row: Subscription, ttlMs: number, replacing: boolean) =>
  Effect.gen(function* () {
    if (replacing) return yield* new UpstreamMcp({ connectionId: row.connectionId, reason: 'remote-rpc' })
    const renewed = yield* subscribeLease(client, yield* freshGeneration(client, row), ttlMs, true)
    // expected: the old generation's lease may already be gone, or out of reach; it lapses at its finite expiry.
    yield* Effect.ignore(unsubscribeEvents(client, row))
    return renewed
  })

const subscribeLease = (
  client: EventClient,
  row: Subscription,
  ttlMs: number,
  replacing: boolean,
): Effect.Effect<Subscription, AppError> =>
  Effect.gen(function* () {
    const { store, cipher } = client
    const now = yield* Clock.currentTimeMillis
    yield* currentLease(client, row)
    if (row.remoteId === null) store.patchLive(row, { status: 'pending', updatedAt: now })
    const secret = yield* attempt(() => cipher.decrypt(row.secret, secretAad(row)))
    const args = yield* argumentsOf(row)
    const result = yield* request({
      client,
      row,
      method: 'events/subscribe',
      params: {
        name: row.name,
        arguments: args,
        delivery: { mode: 'webhook', url: row.callbackUrl, secret },
        cursor: row.cursor,
        ttlMs: Math.min(EVENT_LIMITS.maxTtlMs, Math.max(EVENT_LIMITS.minTtlMs, ttlMs)),
        maxAgeMs: 7 * 86_400_000,
      },
      schema: EventsSubscribeResult,
      guard: currentLease(client, row),
    })
    const refreshBefore = Date.parse(result.refreshBefore)
    if (!Number.isFinite(refreshBefore) || refreshBefore <= now || refreshBefore > now + EVENT_LIMITS.maxTtlMs)
      return yield* new UpstreamMcp({ connectionId: row.connectionId, reason: 'remote-rpc' })
    if (idChanged(store, row, result.id)) return yield* movedLease(client, row, ttlMs, replacing)
    const margin = Math.min(300_000, Math.max(1000, (refreshBefore - now) / 10))
    const jitter = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0
    const nextRefreshAt = Math.max(now + 1000, refreshBefore - margin - (jitter % 1000))
    const status = leaseStatus(result)
    yield* client.wake(Math.min(nextRefreshAt, now + 300_000))
    const written = store.patchLive(row, {
      remoteId: result.id,
      refreshBefore,
      nextRefreshAt,
      cursor: result.cursor ?? row.cursor,
      status,
      lastError: null,
      updatedAt: now,
    })
    if (!written) return yield* new Conflict({ reason: 'event lease changed' })
    const saved = store.get(row.id)
    if (saved === undefined) return yield* new InvalidInput({ reason: 'event intent missing' })
    return saved
  })

/** The occurrences after `row`'s cursor, one page. */
export const pollEvents = (client: EventClient, row: Subscription) =>
  Effect.flatMap(argumentsOf(row), (args) =>
    request({
      client,
      row,
      method: 'events/poll',
      params: {
        name: row.name,
        arguments: args,
        cursor: row.cursor,
        maxEvents: EVENT_LIMITS.page,
        maxAgeMs: 7 * 86_400_000,
      },
      schema: EventsPollResult,
      guard: currentLease(client, row),
    }),
  )

/** Ends `row`'s remote subscription; one the server no longer knows (-32011) is already gone. */
export const unsubscribeEvents = (client: EventClient, row: Subscription): Effect.Effect<void, AppError> =>
  Effect.flatMap(argumentsOf(row), (args) =>
    request({
      client,
      row,
      method: 'events/unsubscribe',
      params: { name: row.name, arguments: args, delivery: { mode: 'webhook', url: row.callbackUrl } },
      schema: EventsUnsubscribeResult,
    }),
  ).pipe(
    Effect.asVoid,
    Effect.catchTag('UpstreamMcp', (error) => (error.code === -32011 ? Effect.void : Effect.fail(error))),
  )
