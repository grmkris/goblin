import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'
import { type EventClient, prepareEvents, subscribeEvents } from '../../src/mcp/events/client.ts'
import { SqliteEventStore } from '../../src/mcp/events/store.ts'
import { CredentialCipher } from '../../src/mcp/oauth/cipher.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const CALLBACK = 'https://goblin.test/hooks/mcp-events/owner/feed/token'
const Delivery = Schema.Struct({ url: Schema.String })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** A callback URL without its generation marker: the connection's hook path. */
const base = (url: string) => url.replace(/[?&]goblin_generation=[^&]+/u, '')

/** One Events request the server answered: its method, the selector's name and arguments and the webhook URL. */
type Request = { readonly method: string; readonly name: unknown; readonly arguments: unknown; readonly url: string }

/**
 * The Events client over real SQLite and a server that answers each subscribe with `ids` in turn (the last one again
 * after that), as a gateway does when it reaches the app through another of the owner's accounts: every request is
 * kept with its selector and URL, and `verifying` runs before a subscribe is answered, as a verification delivery would.
 */
const world = async (ids: readonly string[], verifying: (store: SqliteEventStore, url: string) => void = () => {}) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const store = new SqliteEventStore(durable(db))
  store.grant('feed', 'post.created', '{"chat":"all"}', true, Date.now())
  const requests: Request[] = []
  const answers = [...ids]
  const client: EventClient = {
    connections: {
      server: (connectionId) => Effect.succeed({ connectionId, endpoint: 'https://feed.test/mcp' }),
      events: (_connectionId, method, params, schema, authorize) =>
        Effect.gen(function* () {
          yield* authorize
          const { url } = yield* Effect.orDie(Schema.decodeUnknownEffect(Delivery)(params['delivery']))
          requests.push({ method, name: params['name'], arguments: params['arguments'], url })
          if (method === 'events/subscribe') verifying(store, url)
          const id = (answers.length > 1 ? answers.shift() : answers[0]) ?? ''
          const answer =
            method === 'events/subscribe'
              ? { id, refreshBefore: new Date(Date.now() + 3_600_000).toISOString(), cursor: 'c1', truncated: false }
              : {}
          return yield* Effect.orDie(Schema.decodeUnknownEffect(schema)(answer))
        }),
    },
    store,
    cipher: await CredentialCipher.fromBase64(KEY),
    principal: 'owner',
    callback: () => Effect.succeed(CALLBACK),
    wake: () => Effect.void,
    authorize: () => Effect.void,
    connected: () => Effect.void,
  }
  return { store, client, requests }
}

describe('a lease renewal the server answers with another subscription id (ADRs 0073, 0096)', () => {
  it('subscribes a fresh generation, keeps its local id and cursor, and ends the old one by its exact selector and URL', async () => {
    const { store, client, requests } = await world(['sub-a', 'sub-b'])
    const prepared = await run(prepareEvents(client, 'feed', 'post.created', { chat: 'all' }))
    const first = await run(subscribeEvents(client, prepared))
    expect(first).toMatchObject({ remoteId: 'sub-a', status: 'active', cursor: 'c1' })
    const renewed = await run(subscribeEvents(client, first))
    expect(renewed).toMatchObject({ id: first.id, remoteId: 'sub-b', status: 'active', cursor: 'c1' })
    // Its own generation: the same hook path with another marker, and another secret.
    expect(renewed.callbackUrl).not.toBe(first.callbackUrl)
    expect(base(renewed.callbackUrl)).toBe(base(first.callbackUrl))
    expect(renewed.secret).not.toBe(first.secret)
    const selector = { name: 'post.created', arguments: { chat: 'all' } }
    expect(requests).toEqual([
      { method: 'events/subscribe', ...selector, url: first.callbackUrl },
      { method: 'events/subscribe', ...selector, url: first.callbackUrl },
      { method: 'events/subscribe', ...selector, url: renewed.callbackUrl },
      { method: 'events/unsubscribe', ...selector, url: first.callbackUrl },
    ])
    expect(store.get(first.id)).toMatchObject({ remoteId: 'sub-b', callbackUrl: renewed.callbackUrl })
    // A renewal answered with the id it has changes nothing but the lease's time.
    const again = await run(subscribeEvents(client, renewed))
    expect(again).toMatchObject({ remoteId: 'sub-b', callbackUrl: renewed.callbackUrl })
    expect(requests).toHaveLength(5)
  })

  it('refuses a second change of id within one renewal, and leaves the old generation for its expiry', async () => {
    const first = { url: '' }
    // The fresh generation's verification names one id, and its subscribe answers another.
    const { store, client, requests } = await world(['sub-a', 'sub-b', 'sub-c'], (events, url) => {
      const row = events.live()[0]
      if (row !== undefined && first.url !== '' && url !== first.url) events.patch(row.id, { remoteId: 'sub-verified' })
    })
    const prepared = await run(prepareEvents(client, 'feed', 'post.created', { chat: 'all' }))
    const subscribed = await run(subscribeEvents(client, prepared))
    first.url = subscribed.callbackUrl
    await expect(run(subscribeEvents(client, subscribed))).rejects.toMatchObject({ reason: 'remote-rpc' })
    expect(requests.map(({ method }) => method)).toEqual(['events/subscribe', 'events/subscribe', 'events/subscribe'])
    expect(store.get(subscribed.id)).toMatchObject({ remoteId: 'sub-verified', status: 'pending' })
  })
})
