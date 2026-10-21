import type { ApiKeyView } from '@goblin/contracts'
import { NotFound, WorkspaceAccountApi } from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { keysQuery, updateKeyMutation } from '../src/account/queries.ts'
import { workspaceAccount } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from './query/testing.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

const KEY: ApiKeyView = {
  id: 'key-1',
  name: 'swarm',
  scopes: ['topics', 'conversations', 'personas'],
  servers: ['mycut'],
  origins: [],
  createdAt: '2026-10-20T00:00:00.000Z',
}

/**
 * The real keys group served in memory over one key, and the clients group it never reaches, under a workspace's
 * prefix as the edge serves them (ADR 0089): a call that is not under `/w/kris` is no route.
 */
const fakeAccount = () => {
  const state = { key: KEY }
  const Keys = HttpApiBuilder.group(WorkspaceAccountApi, 'keys', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(WorkspaceAccountApi.groups.keys),
      list: () => Effect.succeed([state.key]),
      update: ({ params, payload }) => {
        if (params.keyId !== state.key.id) return Effect.fail(new NotFound({ what: 'key' }))
        state.key = {
          ...state.key,
          scopes: payload.scopes ?? state.key.scopes,
          origins: payload.origins ?? state.key.origins,
        }
        return Effect.succeed(state.key)
      },
    }),
  )
  const Clients = HttpApiBuilder.group(WorkspaceAccountApi, 'clients', (handlers) =>
    handlers.handleAll(unusedHandlers(WorkspaceAccountApi.groups.clients)),
  )
  const Members = HttpApiBuilder.group(WorkspaceAccountApi, 'members', (handlers) =>
    handlers.handleAll(unusedHandlers(WorkspaceAccountApi.groups.members)),
  )
  const served = fakeHttpApi(WorkspaceAccountApi, Layer.mergeAll(Keys, Clients, Members))
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), 'http://app.test'), init)
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/w/kris/api/')) return Promise.resolve(new Response(null, { status: 404 }))
      url.pathname = url.pathname.slice('/w/kris'.length)
      return served.fetch(new Request(url, request))
    },
    { preconnect: () => undefined },
  )
  return { ...served, fetch, state }
}

const fake = fakeAccount()
beforeAll(() => {
  // The page is the Settings of the workspace at `kris`.
  vi.stubGlobal('location', new URL('http://app.test/w/kris/settings'))
  vi.stubGlobal('window', { location: new URL('http://app.test/w/kris/settings') })
  vi.stubGlobal('fetch', fake.fetch)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await workspaceAccount.runtime.dispose()
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
      // The page's own workspace is in every call's path: the edge strips it, as this fake does.
      expect(fake.calls.every((call) => new URL(call.url).pathname.startsWith('/api/keys'))).toBe(true)
      await expect(change.mutate({ keyId: 'key-9', scopes: ['inspect'] })).rejects.toBeInstanceOf(NotFound)
    } finally {
      unsubscribe()
    }
  })
})
