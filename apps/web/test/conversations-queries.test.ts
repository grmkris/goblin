import { ConversationsGroup, OwnerApi, OwnerAdmission, ownerApiOf } from '@goblin/contracts/api'
import { InfiniteQueryObserver, MutationObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { historyQuery, submitMutation } from '../src/conversations/queries.ts'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from './query/testing.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

/** Entries 1 to 9 of chat 7, two to a page: a page before `before` holds the messages of the two entries just older. */
const page = (before: number) => {
  const ids = [before - 2, before - 1].filter((id) => id >= 1)
  const messages = ids.map((id) => ({
    id: `7:e${id}`,
    role: 'user',
    content: 'x',
    metadata: { goblin: { entryId: id } },
  }))
  return { messages, next: ids[0] ?? before, more: (ids[0] ?? 1) > 1 }
}

/** The real conversations group served in memory: its history pages and the owner's messages, nothing else. */
const fakeOwner = () => {
  const Conversations = HttpApiBuilder.group(OwnerApi, 'conversations', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.conversations),
      submit: ({ payload }) =>
        Effect.succeed({ operationId: payload.operationId, session: 'session-7', accepted: true }),
      history: ({ query }) => Effect.succeed(page(query.before)),
    }),
  )
  const gate = Layer.succeed(
    OwnerAdmission,
    OwnerAdmission.of((handler) => handler),
  )
  return fakeHttpApi(ownerApiOf(ConversationsGroup), Conversations.pipe(Layer.provide(gate)))
}

const fake = fakeOwner()
let seen = 0
const calls = () => fake.calls.slice(seen)
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => {
  seen = fake.calls.length
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

describe('conversation queries', () => {
  it('page a chat history backwards from where its stream opens, until nothing older remains', async () => {
    const client = testQueryClient()
    const history = new InfiniteQueryObserver(client, historyQuery('7', 6))
    const unsubscribe = history.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(history.getCurrentResult().data?.pages).toHaveLength(1))
      expect(history.getCurrentResult().hasNextPage).toBe(true)
      await history.fetchNextPage()
      await history.fetchNextPage()
      const pages = history.getCurrentResult().data?.pages ?? []
      expect(pages.map((each) => each.messages.length)).toEqual([2, 2, 1])
      expect(history.getCurrentResult().hasNextPage).toBe(false)
      expect(calls().map((request) => new URL(request.url).search)).toEqual(['?before=6', '?before=4', '?before=2'])
    } finally {
      unsubscribe()
    }
  })

  it('read no history while the stream opens at the beginning', async () => {
    const client = testQueryClient()
    const history = new InfiniteQueryObserver(client, historyQuery('7', undefined))
    const unsubscribe = history.subscribe(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    unsubscribe()
    expect(history.getCurrentResult().fetchStatus).toBe('idle')
    expect(calls()).toEqual([])
  })

  it("send the owner's message as its operation", async () => {
    const client = testQueryClient()
    const submit = new MutationObserver(client, submitMutation)
    await expect(submit.mutate({ id: '7', message: { input: 'Hello', operationId: 'op-7' } })).resolves.toEqual({
      operationId: 'op-7',
      session: 'session-7',
      accepted: true,
    })
    expect(calls().at(-1)?.headers.get('x-goblin-operation')).toBe('op-7')
  })
})
