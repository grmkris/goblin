import {
  CONVERSATION_UPDATED,
  type ConversationSelector,
  type EventsPolled,
  type EventsSubscribed,
  type PublishedEvents,
} from '@goblin/contracts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import { type AppError, Conflict, NotFound, attempt, attemptSync } from '../http/errors.ts'
import type { CredentialCipher } from '../mcp/oauth/cipher.ts'
import { type PublishFetch, challenge, secretAad } from './deliver.ts'
import { DESCRIPTOR, cursorOf } from './event.ts'
import { behind, headOf, notePoll, page } from './journal.ts'
import { dropLease, endHolder, leaseCounts, leaseOf, renewLease } from './leases.ts'
import { PUBLISH_LIMITS, callbackUrl, canonicalJson, leaseMs, subscriptionId, webhookSecret } from './policy.ts'

/**
 * A subscribe, as the handler has checked it: who holds the lease and the grant it is made under (a credential's, ADR
 * 0114; none for a member's), its selector, the URL, the secret and the ask.
 */
export type LeaseRequest = {
  readonly holder: string
  readonly grant?: string | undefined
  readonly selector: ConversationSelector
  readonly url: string
  readonly secret: string
  readonly ttlMs?: number | null | undefined
  readonly cursor?: string | null | undefined
}

/**
 * A poll, as the handler has checked it: the grant whose Topic list filters it (none reaches every chat), its selector
 * and bounds.
 */
export type PollRequest = {
  readonly grant: string | undefined
  readonly selector: ConversationSelector
  readonly cursor: string | null
  readonly maxEvents?: number | undefined
  readonly maxAgeMs?: number | undefined
}

/**
 * The MCP Events goblin publishes (ADR 0112): `conversation.updated` and its leases, polls and deliveries. Reach and
 * admission are the handler's (`publish/api.ts`); this holds the journal and the leases.
 */
export class Published extends Context.Service<
  Published,
  {
    readonly list: Effect.Effect<PublishedEvents>
    /** A lease made or renewed; a new one, a changed secret or a failing one is verified by a signed challenge first. */
    readonly subscribe: (request: LeaseRequest) => Effect.Effect<EventsSubscribed, AppError>
    /** The lease of this holder, selector and URL ends; `NotFound` when there is none. */
    readonly unsubscribe: (request: Omit<LeaseRequest, 'secret' | 'ttlMs' | 'cursor'>) => Effect.Effect<void, AppError>
    readonly poll: (request: PollRequest) => Effect.Effect<EventsPolled, AppError>
    /** Every lease of `holder` ends with a `terminated` control; how many. */
    readonly terminate: (holder: string) => Effect.Effect<number, AppError>
    /** The wake's sweep: leases past their end end, the journal is pruned, what is due goes out, the next wake is armed. */
    readonly maintain: Effect.Effect<void, AppError>
    /** When something next falls due, if anything does. */
    readonly nextDue: Effect.Effect<number | undefined>
  }
>()('goblin/publish/Published') {}

/** What leases and polls need of the agent: the database, the cipher, the way out, and the drain and its wake. */
export type LeasePorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly cipher: CredentialCipher
  readonly send: PublishFetch
  /** Sends what is due now, in the background, and arms the next wake. */
  readonly kick: Effect.Effect<void>
  /** Arms the wake for when something next falls due. */
  readonly arm: Effect.Effect<void, AppError>
  readonly newId: Effect.Effect<string, AppError>
}

/** A selector as its lease keeps it: canonical arguments, and the Topic or chat it names. */
const selectorRow = (selector: ConversationSelector) => ({
  argumentsJson: canonicalJson(selector),
  topicId: selector.topic === undefined ? null : Number(selector.topic),
  chatId: selector.chat ?? null,
})

/** The lease's id for `request`: its holder, selector and URL, the URL checked first. */
const idOf = (request: Pick<LeaseRequest, 'holder' | 'selector' | 'url'>) =>
  Effect.gen(function* () {
    const url = yield* attemptSync(() => callbackUrl(request.url))
    const selector = { name: CONVERSATION_UPDATED, arguments: request.selector }
    return { url, id: yield* attempt(() => subscriptionId(request.holder, selector, url)) }
  })

/** Whether the lease `id` is active and running with `secret`: then renewing it needs no challenge. */
const keeps = (ports: LeasePorts, id: string, secret: string, now: number) =>
  Effect.gen(function* () {
    const lease = leaseOf(ports.db, id)
    if (lease === undefined || lease.status !== 'active' || lease.refreshBefore <= now) return false
    const sealed = lease.secret
    // expected: a secret that no longer opens is a changed one, verified again.
    const kept = yield* attempt(() => ports.cipher.decrypt(sealed, secretAad(id))).pipe(Effect.orElseSucceed(() => ''))
    return kept === secret
  })

/** `subscribe`: checks, the holder's and workspace's counts, the challenge outside any transaction, then one write. */
const subscribeWith = (ports: LeasePorts) =>
  Effect.fn('Published.subscribe')(function* (request: LeaseRequest) {
    const { db, cipher } = ports
    const now = yield* Clock.currentTimeMillis
    const { url, id } = yield* idOf(request)
    const secret = yield* attemptSync(() => webhookSecret(request.secret))
    const truncated = yield* attemptSync(() => behind(db, request.cursor))
    const counts = leaseCounts(db, request.holder, now, id)
    if (counts.holder >= PUBLISH_LIMITS.perHolder || counts.workspace >= PUBLISH_LIMITS.perWorkspace)
      return yield* new Conflict({ reason: 'event_subscriptions' })
    if (
      !(yield* keeps(ports, id, secret, now)) &&
      !(yield* challenge(ports.send, { url, subscriptionId: id, secret }, ports.newId))
    )
      return yield* new Conflict({ reason: 'event_callback' })
    const sealed = yield* attempt(() => cipher.encrypt(secret, secretAad(id)))
    const refreshBefore = now + leaseMs(request.ttlMs)
    const before = leaseOf(db, id)
    yield* Effect.sync(() =>
      renewLease(db, {
        id,
        principal: request.holder,
        grantId: request.grant ?? null,
        name: CONVERSATION_UPDATED,
        ...selectorRow(request.selector),
        url,
        secret: sealed,
        refreshBefore,
        status: 'active',
        lastError: null,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      }),
    )
    yield* ports.arm
    return {
      id,
      refreshBefore: DateTime.formatIso(DateTime.makeUnsafe(refreshBefore)),
      cursor: cursorOf(headOf(db)),
      truncated,
      deliveryStatus: { active: true, lastError: null },
    }
  })

/** The published Events over `ports`. `maintain` and `nextDue` are the layer's: they own the drain. */
export const leasesOf = (ports: LeasePorts) => ({
  list: Effect.succeed({ events: [DESCRIPTOR] }),
  subscribe: subscribeWith(ports),
  unsubscribe: Effect.fn('Published.unsubscribe')(function* (
    request: Omit<LeaseRequest, 'secret' | 'ttlMs' | 'cursor'>,
  ) {
    const { id } = yield* idOf(request)
    const lease = leaseOf(ports.db, id)
    if (lease === undefined || lease.status === 'terminated') return yield* new NotFound({ what: 'subscription' })
    yield* Effect.sync(() => dropLease(ports.db, id))
  }),
  poll: Effect.fn('Published.poll')(function* (request: PollRequest) {
    const now = yield* Clock.currentTimeMillis
    yield* Effect.sync(() => notePoll(ports.db, now))
    const retention = PUBLISH_LIMITS.retentionMs
    return yield* attemptSync(() =>
      page(ports.db, {
        grant: request.grant,
        name: CONVERSATION_UPDATED,
        topicId: request.selector.topic === undefined ? undefined : Number(request.selector.topic),
        chat: request.selector.chat,
        cursor: request.cursor,
        maxEvents: request.maxEvents ?? PUBLISH_LIMITS.pageEvents,
        cutoff: now - Math.min(request.maxAgeMs ?? retention, retention),
      }),
    )
  }),
  terminate: Effect.fn('Published.terminate')(function* (holder: string) {
    const now = yield* Clock.currentTimeMillis
    const ended = yield* Effect.sync(() => endHolder(ports.db, holder, now))
    if (ended > 0) yield* ports.kick
    return ended
  }),
})
