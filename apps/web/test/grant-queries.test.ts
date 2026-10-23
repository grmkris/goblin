import {
  type ConsentTerms,
  GRANT_SPEC,
  type GrantTerms,
  type InboundClient,
  PRESET,
  presetFor,
} from '@goblin/contracts'
import {
  AccountApi,
  McpGroup,
  NotFound,
  OwnerAdmission,
  OwnerApi,
  PersonasGroup,
  TopicsGroup,
  ownerApiOf,
} from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrantsAccountApi, grantsAccount } from '../src/lib/api-grants.ts'
import { clientGrantMutation, clientTermsQuery, clientsQuery, reachItemsQuery } from '../src/account/queries.ts'
import { account, owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from './query/testing.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

const CLIENT: InboundClient = {
  clientId: 'claude-code',
  name: 'Claude Code',
  reach: { all: true, workspaces: [] },
  grantId: 'cg_1',
  terms: { ...PRESET, name: 'Claude Code' },
}
const SPEC = { levels: GRANT_SPEC.levels, extras: GRANT_SPEC.extras, reachOptions: [] }
const KEY_TERMS: GrantTerms = { ...presetFor('swarm', ['ws_acme']), level: 'read' }

/**
 * The grants group and the person's clients served in memory, as the Worker serves them outside any workspace, and one
 * workspace's Topics, Personas and connections under `/w/acme`, as its agent answers them there.
 */
const fakeWorker = () => {
  const state = { client: CLIENT, key: KEY_TERMS }
  const Grants = HttpApiBuilder.group(GrantsAccountApi, 'grants', (handlers) =>
    handlers.handleAll({
      clientTerms: ({ params }): Effect.Effect<ConsentTerms, NotFound> =>
        params.clientId === state.client.clientId
          ? Effect.succeed({
              spec: SPEC,
              defaults: { ...PRESET, name: 'Claude Code' },
              current: state.client.terms ?? null,
            })
          : Effect.fail(new NotFound({ what: 'client' })),
      clientGrant: ({ params, payload }) => {
        state.client = { ...state.client, terms: payload.terms }
        return Effect.succeed({ grantId: `cg_${params.clientId}`, terms: payload.terms, expiresAt: null })
      },
      terms: ({ params }) =>
        params.id === 'key_1'
          ? Effect.succeed({
              spec: SPEC,
              defaults: KEY_TERMS,
              current: state.key,
              grantId: 'key_1',
              summary: {
                ...state.key,
                grantId: 'key_1',
                keyId: 'key_1',
                expiresAt: null,
                widenUrl: 'https://app.test',
              },
            })
          : Effect.fail(new NotFound({ what: 'grant' })),
      widen: ({ payload }) => {
        state.key = payload.terms
        return Effect.succeed({ ...payload, expiresAt: null })
      },
    }),
  )
  const grants = fakeHttpApi(GrantsAccountApi, Grants)
  const Clients = HttpApiBuilder.group(AccountApi, 'clients', (handlers) =>
    handlers.handleAll({ ...unusedHandlers(AccountApi.groups.clients), list: () => Effect.succeed([state.client]) }),
  )
  const Workspaces = HttpApiBuilder.group(AccountApi, 'workspaces', (handlers) =>
    handlers.handleAll(unusedHandlers(AccountApi.groups.workspaces)),
  )
  const Invitations = HttpApiBuilder.group(AccountApi, 'invitations', (handlers) =>
    handlers.handleAll(unusedHandlers(AccountApi.groups.invitations)),
  )
  const ClientErrors = HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) =>
    handlers.handleAll(unusedHandlers(AccountApi.groups.clientErrors)),
  )
  const Unused = HttpApiBuilder.group(AccountApi, 'grants', (handlers) =>
    handlers.handleAll(unusedHandlers(AccountApi.groups.grants)),
  )
  const clients = fakeHttpApi(AccountApi, Layer.mergeAll(Clients, Workspaces, Invitations, ClientErrors, Unused))
  const gate = Layer.succeed(
    OwnerAdmission,
    OwnerAdmission.of((handler) => handler),
  )
  const Topics = HttpApiBuilder.group(OwnerApi, 'topics', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.topics),
      list: () =>
        Effect.succeed({
          topics: [
            {
              id: 1,
              name: 'Personal',
              conversation: '1',
              personal: true,
              revision: 1,
              archived: false,
              searchExcluded: false,
              updatedAt: 1,
            },
            { id: 4, name: 'Old', conversation: '4', revision: 1, archived: true, searchExcluded: false, updatedAt: 1 },
          ],
        }),
    }),
  )
  const Personas = HttpApiBuilder.group(OwnerApi, 'personas', (handlers) =>
    handlers.handleAll(unusedHandlers(OwnerApi.groups.personas)),
  )
  const Mcp = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.mcp),
      servers: () =>
        Effect.succeed([
          {
            connectionId: 'notes',
            label: 'Notes',
            endpoint: 'https://notes.example',
            status: 'connected' as const,
            live: true,
            source: 'added' as const,
          },
        ]),
    }),
  )
  const agent = fakeHttpApi(
    ownerApiOf(TopicsGroup, PersonasGroup, McpGroup),
    Layer.mergeAll(Topics, Personas, Mcp).pipe(Layer.provide(gate)),
  )
  const seen: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), 'http://app.test'), init)
      const url = new URL(request.url)
      seen.push(`${request.method} ${url.pathname}`)
      if (url.pathname.startsWith('/w/acme/api/')) {
        url.pathname = url.pathname.slice('/w/acme'.length)
        return agent.fetch(new Request(url, request))
      }
      if (url.pathname === '/api/clients') return clients.fetch(request)
      if (url.pathname.startsWith('/api/grants/') || url.pathname.startsWith('/api/clients/'))
        return grants.fetch(request)
      return Promise.resolve(new Response(null, { status: 404 }))
    },
    { preconnect: () => undefined },
  )
  return {
    fetch,
    state,
    calls: () => [...grants.calls, ...clients.calls, ...agent.calls],
    seen,
    reset: () => {
      seen.length = 0
      state.client = CLIENT
      state.key = KEY_TERMS
      for (const served of [grants, clients, agent]) served.calls.length = 0
    },
    dispose: () => Promise.all([grants.dispose(), clients.dispose(), agent.dispose()]),
  }
}

const fake = fakeWorker()
beforeAll(() => {
  // A person's own page, outside any workspace.
  vi.stubGlobal('location', new URL('http://app.test/consent?client_id=claude-code'))
  vi.stubGlobal('window', { location: new URL('http://app.test/consent?client_id=claude-code') })
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => fake.reset())
afterAll(async () => {
  vi.unstubAllGlobals()
  await Promise.all([grantsAccount.runtime.dispose(), account.runtime.dispose(), owner.runtime.dispose()])
  await fake.dispose()
})

describe("an MCP client's grant (ADR 0114)", () => {
  it("is offered with its current terms, and a change settles once the person's clients are fresh", async () => {
    const client = testQueryClient()
    const list = new QueryObserver(client, clientsQuery)
    const unsubscribe = list.subscribe(() => undefined)
    try {
      expect(await client.query(clientTermsQuery('claude-code'))).toMatchObject({ current: { level: 'write' } })
      await vi.waitFor(() => expect(list.getCurrentResult().data?.[0]?.terms?.level).toBe('write'))
      const change = new MutationObserver(client, clientGrantMutation)
      const terms: GrantTerms = { ...PRESET, name: 'Claude Code', level: 'read', extras: ['inspect'] }
      await change.mutate({ clientId: 'claude-code', terms })
      expect(list.getCurrentResult().data?.[0]?.terms).toEqual(terms)
      expect(client.getQueryState(clientTermsQuery('claude-code').queryKey)?.isInvalidated).toBe(true)
      const put = fake.calls().find((call) => call.method === 'PUT')
      expect(new URL(put?.url ?? '').pathname).toBe('/api/clients/claude-code/grant')
      expect(put?.headers.get('x-goblin-csrf')).toBe('1')
      await expect(client.query(clientTermsQuery('someone-else'))).rejects.toBeInstanceOf(NotFound)
    } finally {
      unsubscribe()
    }
  })
})

describe("what a grant's editor offers to pick", () => {
  it("reads the named workspace's lists from its agent, whichever page asks, only once picking", async () => {
    const client = testQueryClient()
    expect(await client.query(reachItemsQuery('acme', 'topics', true))).toEqual([{ id: '1', label: 'Personal' }])
    expect(await client.query(reachItemsQuery('acme', 'connections', true))).toEqual([{ id: 'notes', label: 'Notes' }])
    // The page is a person's own, outside any workspace: each read names the workspace it is for.
    expect(fake.seen).toEqual(['GET /w/acme/api/topics', 'GET /w/acme/api/mcp/servers'])
    const idle = new QueryObserver(client, reachItemsQuery('acme', 'personas', false))
    const unsubscribe = idle.subscribe(() => undefined)
    unsubscribe()
    expect(idle.getCurrentResult().fetchStatus).toBe('idle')
    expect(fake.seen).toHaveLength(2)
  })
})
