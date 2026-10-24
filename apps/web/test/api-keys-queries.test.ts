import { type ApiKeyView, type GrantTerms, presetFor } from '@goblin/contracts'
import { AccessInsufficient, Forbidden, InvalidInput, NotFound, WorkspaceAccountApi } from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKeyMutation, keysQuery, rotateKeyMutation, updateKeyMutation } from '../src/account/queries.ts'
import { grantFailure } from '../src/components/grant-editor.tsx'
import { workspaceAccount } from '../src/lib/api.ts'
import { describeError } from '../src/lib/query/app-error.ts'
import { fakeHttpApi, testQueryClient } from './query/testing.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

const KEY: ApiKeyView = {
  id: 'key-1',
  name: 'swarm',
  createdAt: '2026-10-20T00:00:00.000Z',
  start: 'gbk_aaaaaa',
  grantId: 'key-1',
  terms: presetFor('swarm', ['ws_kris']),
}
/** The secret the fake's rotation answers, made up for the test (ADR 0105). */
const ROTATED = `gbk_${'b'.repeat(64)}`

/**
 * The real keys group served in memory over one key, and the members group it never reaches, under a workspace's
 * prefix as the edge serves them (ADR 0089): a call that is not under `/w/kris` is no route. A key is made and changed
 * by its grant's terms (ADR 0114).
 */
const fakeAccount = () => {
  const state = { key: KEY }
  const Keys = HttpApiBuilder.group(WorkspaceAccountApi, 'keys', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(WorkspaceAccountApi.groups.keys),
      list: () => Effect.succeed([state.key]),
      // As the Worker refuses them: `keys` from anyone but an owner, and a server address that is no public https one.
      create: ({ payload }) => {
        if (payload.terms.extras.includes('keys')) return Effect.fail(new Forbidden({ reason: 'role', ref: 'r-role' }))
        if (payload.terms.reach.origins.some(({ origin }) => !origin.startsWith('https://')))
          return Effect.fail(new InvalidInput({ reason: 'key_origin', ref: 'r-origin' }))
        return Effect.succeed({
          key: { ...KEY, id: 'key-2', name: payload.name, grantId: 'key-2', terms: payload.terms },
          secret: `gbk_${'c'.repeat(64)}`,
        })
      },
      update: ({ params, payload }) => {
        // A call made with a key whose own grant lacks `keys` is refused with its widening link (ADR 0114).
        if (params.keyId === 'key-narrow')
          return Effect.fail(
            new AccessInsufficient({
              missing: { extra: 'keys' },
              widenUrl: 'https://app.test/consent/widen?grant=key-narrow&extra=keys',
              ref: 'r-widen',
            }),
          )
        if (params.keyId !== state.key.id) return Effect.fail(new NotFound({ what: 'key' }))
        state.key = { ...state.key, terms: payload.terms }
        return Effect.succeed(state.key)
      },
      rotate: ({ params }) => {
        if (params.keyId !== state.key.id) return Effect.fail(new NotFound({ what: 'key' }))
        state.key = { ...state.key, start: ROTATED.slice(0, 10) }
        return Effect.succeed({ key: state.key, secret: ROTATED })
      },
    }),
  )
  const Members = HttpApiBuilder.group(WorkspaceAccountApi, 'members', (handlers) =>
    handlers.handleAll(unusedHandlers(WorkspaceAccountApi.groups.members)),
  )
  const DeveloperApps = HttpApiBuilder.group(WorkspaceAccountApi, 'developerApps', (handlers) =>
    handlers.handleAll(unusedHandlers(WorkspaceAccountApi.groups.developerApps)),
  )
  const Installations = HttpApiBuilder.group(WorkspaceAccountApi, 'installations', (handlers) =>
    handlers.handleAll(unusedHandlers(WorkspaceAccountApi.groups.installations)),
  )
  const served = fakeHttpApi(WorkspaceAccountApi, Layer.mergeAll(Keys, Members, DeveloperApps, Installations))
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
  return { calls: served.calls, fetch, state, dispose: served.dispose }
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

describe("a key's grant (ADR 0114)", () => {
  it('changes in place and the list is fresh once the change settles', async () => {
    const client = testQueryClient()
    const list = new QueryObserver(client, keysQuery)
    const unsubscribe = list.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(list.getCurrentResult().data?.[0]?.terms.level).toBe('write'))
      const change = new MutationObserver(client, updateKeyMutation)
      const terms: GrantTerms = { ...presetFor('swarm', ['ws_kris']), level: 'manage', extras: ['inspect'] }
      await change.mutate({ keyId: 'key-1', terms })
      expect(list.getCurrentResult().data?.[0]).toMatchObject({ id: 'key-1', terms })
      const patch = fake.calls.find((call) => call.method === 'PATCH')
      expect(new URL(patch?.url ?? '').pathname).toBe('/api/keys/key-1')
      expect(await patch?.json()).toEqual({ terms })
      // The page's own workspace is in every call's path: the edge strips it, as this fake does.
      expect(fake.calls.every((call) => new URL(call.url).pathname.startsWith('/api/keys'))).toBe(true)
      await expect(change.mutate({ keyId: 'key-9', terms })).rejects.toBeInstanceOf(NotFound)
    } finally {
      unsubscribe()
    }
  })

  it('is made with the key, from its name and terms, and its secret is answered once', async () => {
    const client = testQueryClient()
    const make = new MutationObserver(client, createKeyMutation)
    const terms = presetFor('crm', ['ws_kris'])
    expect(await make.mutate({ name: 'crm', terms })).toMatchObject({ key: { name: 'crm', terms } })
    const post = fake.calls.find((call) => call.method === 'POST' && new URL(call.url).pathname === '/api/keys')
    expect(await post?.json()).toEqual({ name: 'crm', terms })
    expect(post?.headers.get('x-goblin-csrf')).toBe('1')
  })
})

describe("a key's refused terms (ADR 0114)", () => {
  it('say why in words: keys only from an owner, servers only at public https addresses', async () => {
    const make = new MutationObserver(testQueryClient(), createKeyMutation)
    const owners: unknown = await make
      .mutate({ name: 'ops', terms: { ...presetFor('ops', ['ws_kris']), extras: ['keys'] } })
      // expected: the test asserts on the failure it captures
      .catch((error: unknown) => error)
    expect(grantFailure(owners, 'make that key')).toBe(
      'Only an owner of the workspace may give Keys: turn it off, or ask an owner. · ref r-role',
    )
    const preset = presetFor('ops', ['ws_kris'])
    const local: unknown = await make
      .mutate({
        name: 'ops',
        terms: { ...preset, reach: { ...preset.reach, origins: [{ origin: 'http://localhost', tools: ['a'] }] } },
      })
      // expected: the test asserts on the failure it captures
      .catch((error: unknown) => error)
    expect(grantFailure(local, 'make that key')).toMatch(/^Each server needs its own https address.* · ref r-origin$/u)
  })

  it('link to widening when the call lacked access, as a path on this site', async () => {
    const change = new MutationObserver(testQueryClient(), updateKeyMutation)
    const refused: unknown = await change
      .mutate({ keyId: 'key-narrow', terms: KEY.terms })
      // expected: the test asserts on the failure it captures
      .catch((error: unknown) => error)
    expect(describeError(refused)).toMatchObject({
      code: 'access_insufficient',
      widenPath: '/consent/widen?grant=key-narrow&extra=keys',
      ref: 'r-widen',
    })
    expect(grantFailure(refused, 'change that key')).toBe('This credential needs more access. · ref r-widen')
  })
})

describe("a key's secret (ADR 0105)", () => {
  it('rotates in place: the answer holds the new secret once, and the list shows its new start, never the secret', async () => {
    const client = testQueryClient()
    const list = new QueryObserver(client, keysQuery)
    const unsubscribe = list.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(list.getCurrentResult().data?.[0]?.id).toBe('key-1'))
      const rotate = new MutationObserver(client, rotateKeyMutation)
      const rotated = await rotate.mutate('key-1')
      expect(rotated).toMatchObject({ key: { id: 'key-1', name: 'swarm' }, secret: ROTATED })
      expect(list.getCurrentResult().data?.[0]).toMatchObject({ id: 'key-1', start: ROTATED.slice(0, 10) })
      expect(JSON.stringify(list.getCurrentResult().data)).not.toContain(ROTATED)
      const post = fake.calls.find((call) => call.method === 'POST' && call.url.endsWith('/rotate'))
      expect(new URL(post?.url ?? '').pathname).toBe('/api/keys/key-1/rotate')
      await expect(rotate.mutate('key-9')).rejects.toBeInstanceOf(NotFound)
    } finally {
      unsubscribe()
    }
  })
})
