import type { LeaseHolder } from '@goblin/contracts/internal'
import { OwnerApi } from '@goblin/contracts/api'
import { InternalApi } from '@goblin/contracts/internal'
import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { chatRow } from '../chats/directory.ts'
import { RequestContext } from '../http/api/context.ts'
import { Forbidden, NotFound, attemptSync } from '../http/errors.ts'
import { listedBy, reachesChat, reachesTopic, requestCredential } from '../grants/policy.ts'
import { Db } from '../runtime/db.ts'
import { appTopics } from '../storage/topics.ts'
import { requireEvent, selectorOf } from './event.ts'
import { Published } from './service.ts'

/**
 * Who holds the leases a request makes (ADR 0112): a server's key, an OAuth client for the person it acts for, or a
 * member's own session.
 */
const requestHolder: Effect.Effect<string> = Effect.map(Effect.serviceOption(RequestContext), (context) => {
  const facts = Option.getOrUndefined(context)
  const credential = facts?.credential
  if (credential?.kind === 'key') return `key:${credential.id}`
  const user = facts?.member?.user ?? 'owner'
  return credential?.kind === 'client' ? `client:${credential.id}:${user}` : `member:${user}`
})

/** A holder as the Worker names it ending (`/internal/publish/terminate`), as its leases name it. */
export const holderOf = (holder: LeaseHolder): string =>
  holder.kind === 'key' ? `key:${holder.keyId}` : `client:${holder.clientId}:${holder.user}`

/**
 * A request's selector, within the caller's reach: its Topic or chat must be there (a chat a Conversation or a thread,
 * never a Persona's fork or a subagent, whose work counts for the chat they work for), and a credential's within its
 * grant (ADR 0114).
 */
const selectorIn = (args: Readonly<Record<string, unknown>> | undefined) =>
  Effect.gen(function* () {
    const selector = yield* attemptSync(() => selectorOf(args))
    const { topic, chat } = selector
    if (topic !== undefined) {
      const id = Number(topic)
      const found = yield* Db.useSync((db) => db.select().from(appTopics).where(eq(appTopics.id, id)).get())
      if (found === undefined) return yield* new NotFound({ what: 'topic' })
      yield* reachesTopic(id)
    }
    if (chat !== undefined) {
      const row = yield* Db.useSync((db) => chatRow(db, chat))
      if (row === undefined || row.role === 'persona' || row.kind === 'subagent')
        return yield* new NotFound({ what: 'conversation' })
      yield* reachesChat(chat)
    }
    return selector
  })

/** The `events` group (ADR 0112): what goblin publishes, its leases and its polls, as the caller reaches them. */
export const EventsHandlers = HttpApiBuilder.group(OwnerApi, 'events', (handlers) =>
  handlers
    .handle('list', () => Published.use((published) => published.list))
    .handle('subscribe', ({ payload }) =>
      Effect.gen(function* () {
        const credential = yield* requestCredential
        if (credential?.workload === true) return yield* new Forbidden({ reason: 'workload_webhook' })
        yield* attemptSync(() => requireEvent(payload.name))
        const selector = yield* selectorIn(payload.arguments)
        const holder = yield* requestHolder
        const grant = credential?.grantId
        const { url, secret } = payload.delivery
        return yield* Published.use((published) =>
          published.subscribe({ holder, grant, selector, url, secret, ttlMs: payload.ttlMs, cursor: payload.cursor }),
        )
      }),
    )
    .handle('unsubscribe', ({ payload }) =>
      Effect.gen(function* () {
        yield* attemptSync(() => requireEvent(payload.name))
        const selector = yield* attemptSync(() => selectorOf(payload.arguments))
        const holder = yield* requestHolder
        yield* Published.use((published) => published.unsubscribe({ holder, selector, url: payload.delivery.url }))
        return {}
      }),
    )
    .handle('poll', ({ payload }) =>
      Effect.gen(function* () {
        yield* attemptSync(() => requireEvent(payload.name))
        const selector = yield* selectorIn(payload.arguments)
        const grant = yield* listedBy('topics')
        return yield* Published.use((published) =>
          published.poll({
            grant,
            selector,
            cursor: payload.cursor ?? null,
            maxEvents: payload.maxEvents,
            maxAgeMs: payload.maxAgeMs,
          }),
        )
      }),
    ),
)

/** The internal `publish` group: the Worker ends a holder's leases before it ends their access. */
export const PublishInternalHandlers = HttpApiBuilder.group(InternalApi, 'publish', (handlers) =>
  handlers.handle('terminate', ({ payload }) =>
    Effect.map(
      Published.use((published) => published.terminate(holderOf(payload.holder))),
      (terminated) => ({ terminated }),
    ),
  ),
)
