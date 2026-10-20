import type { ApiKeyView } from '@goblin/contracts'
import { AccountApi, NotFound } from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { keysQuery, updateKeyMutation } from '../src/account/queries.ts'
import { account } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from './query/testing.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

const KEY: ApiKeyView = {
  id: 'key-1',
  name: 'swarm',
  scopes: ['topics', 'conversations', 'personas'],
  servers: ['mycut'],
  createdAt: '2026-10-20T00:00:00.000Z',
}

/** The real keys group served in memory over one key, and the clients group it never reaches. */
const fakeAccount = () => {
  const state = { key: KEY }
  const Keys = HttpApiBuilder.group(AccountApi, 'keys', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(AccountApi.groups.keys),
      list: () => Effect.succeed([state.key]),
      update: ({ params, payload }) => {
        if (params.keyId !== state.key.id) return Effect.fail(new NotFound({ what: 'key' }))
        state.key = { ...state.key, scopes: payload.scopes }
        return Effect.succeed(state.key)
      },
    }),
  )
  const Clients = HttpApiBuilder.group(AccountApi, 'clients', (handlers) =>
    handlers.handleAll(unusedHandlers(AccountApi.groups.clients)),
  )
  const ClientErrors = HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) =>
    handlers.handleAll(unusedHandlers(AccountApi.groups.clientErrors)),
  )
  return { ...fakeHttpApi(AccountApi, Layer.mergeAll(Keys, Clients, ClientErrors)), state }
}

const fake = fakeAccount()
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await account.runtime.dispose()
  await fake.dispose()
})

describe("a key's scopes (ADR 0084)", () => {
  it('change in place and the list is fresh once the change settles', async () => {
    const client = testQueryClient()
    const list = new QueryObserver(client, keysQuery)
    const unsubscribe = list.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(list.getCurrentResult().data?.[0]?.scopes).toHaveLength(3))
      const change = new MutationObserver(client, updateKeyMutation)
      await change.mutate({ keyId: 'key-1', scopes: ['topics', 'conversations', 'personas', 'inspect'] })
      expect(list.getCurrentResult().data?.[0]).toMatchObject({
        id: 'key-1',
        scopes: expect.arrayContaining(['inspect']),
      })
      const patch = fake.calls.find((call) => call.method === 'PATCH')
      expect(new URL(patch?.url ?? '').pathname).toBe('/api/keys/key-1')
      await expect(change.mutate({ keyId: 'key-9', scopes: ['inspect'] })).rejects.toBeInstanceOf(NotFound)
    } finally {
      unsubscribe()
    }
  })
})
