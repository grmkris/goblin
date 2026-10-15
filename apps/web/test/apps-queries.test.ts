import { AppsGroup, McpGroup, NotFound, OwnerApi, OwnerAdmission, UpstreamMcp, ownerApiOf } from '@goblin/contracts/api'
import type { AppLaunch, AppView, ToolView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import {
  appCallMutation,
  appDiagnosticMutation,
  appLaunchQuery,
  appResourceReadMutation,
  appStateQuery,
  appToolCallMutation,
  perform,
} from '../src/apps/queries.ts'
import { addAndConnectMutation, grantsQuery, mcpKeys, toolGrantMutation } from '../src/mcp/queries.ts'
import { unusedHandlers } from './query/unused-handlers.ts'
import { launchSelection } from '../src/components/apps/residency.ts'

const LAUNCH: AppLaunch = {
  kind: 'agent',
  name: 'tapper',
  release: 'r_1',
  revision: 2,
  state: { n: 2 },
  ui: { module: '', css: '', libs: [] },
}
const OP = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'
const TOOL: ToolView = {
  name: 'mymedia_media_view',
  title: 'Media',
  description: 'Show media',
  appResource: 'ui://media/view',
  suggested: 'run',
  modelVisible: true,
  granted: true,
}
const MCP_APP: AppView = {
  id: '9',
  conversation: '1',
  title: 'Media',
  createdAt: 1,
  source: { kind: 'mcp', callId: 'pi-call-9', connectionId: 'connector', tool: TOOL.name, uri: 'ui://media/view' },
}
const MCP_LAUNCH: AppLaunch = {
  kind: 'mcp',
  connectionId: 'connector',
  uri: 'ui://media/view',
  arguments: { query: 'recent' },
  result: { content: [], structuredContent: { total: 3 } },
}

/** The real contract's Apps and MCP groups, answering one agent app and one MCP server. */
const fakeApps = () => {
  let revision = 2
  const reports: string[] = []
  const callers: Array<string | undefined> = []
  const apps = HttpApiBuilder.group(OwnerApi, 'apps', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.apps),
      launch: ({ params }) =>
        params.id === '7'
          ? Effect.succeed({ ...LAUNCH, revision })
          : params.id === '9'
            ? Effect.succeed(MCP_LAUNCH)
            : Effect.fail(new NotFound({ what: 'app', ref: 'ray-404' })),
      state: () => Effect.succeed({ revision, release: 'r_1', state: { n: revision } }),
      call: ({ payload }) => {
        revision += 1
        return Effect.succeed({ ok: true as const, revision, release: 'r_1', state: { n: revision, by: payload.op } })
      },
      diagnostics: ({ payload }) => {
        reports.push(payload.message)
        return Effect.succeed({ kept: true })
      },
    }),
  )
  const mcp = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.mcp),
      grants: () => Effect.succeed([]),
      tools: () => Effect.succeed([TOOL]),
      addServer: ({ payload }) =>
        Effect.succeed({
          connectionId: 'kiwi-1',
          label: 'Kiwi.com',
          endpoint: payload.endpoint,
          status: 'disconnected' as const,
          live: false,
          source: 'added' as const,
        }),
      connect: ({ params }) => Effect.fail(new UpstreamMcp({ connectionId: params.id, reason: 'timeout' })),
      setToolGrant: ({ payload }) =>
        Effect.succeed([{ connectionId: payload.connectionId, capability: 'tool' as const, name: payload.name }]),
      callTool: ({ headers, payload }) => {
        callers.push(headers['x-mcp-caller'])
        return Effect.succeed({ content: [{ type: 'text', text: payload.name }], extra: 'kept' })
      },
      readResource: ({ headers, payload }) => {
        callers.push(headers['x-mcp-caller'])
        return Effect.succeed({ contents: [{ uri: payload.uri, text: '<p>App</p>' }] })
      },
    }),
  )
  const gate = Layer.succeed(OwnerAdmission, (handler) => handler)
  const server = fakeHttpApi(ownerApiOf(AppsGroup, McpGroup), Layer.mergeAll(apps, mcp).pipe(Layer.provide(gate)))
  return {
    ...server,
    reports,
    callers,
    reset: () => {
      revision = 2
      reports.length = 0
      callers.length = 0
    },
  }
}

const fake = fakeApps()
let seen = 0
const calls = () => fake.calls.slice(seen).map((request) => `${request.method} ${new URL(request.url).pathname}`)
// The app's client is same-origin and built once: it resolves paths against the page and calls the global fetch.
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => {
  fake.reset()
  seen = fake.calls.length
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

describe("an App's frame calls", () => {
  it('keeps the exact tool name for a model-opened App and a fresh replay, without treating a Pi id as a request id', async () => {
    const client = testQueryClient()
    const first = await launchSelection(client, MCP_APP)
    expect(first).toMatchObject({
      kind: 'mcp',
      tool: { name: 'mymedia_media_view', inputSchema: { type: 'object' } },
      connectionId: 'connector',
      uri: 'ui://media/view',
      arguments: { query: 'recent' },
      result: { content: [], structuredContent: { total: 3 } },
    })
    expect(first).not.toHaveProperty('requestId')
    client.clear()
    expect(await launchSelection(client, MCP_APP)).toEqual(first)
    expect(calls()).toEqual(['GET /api/apps/9/launch', 'GET /api/apps/9/launch'])
  })

  it('opens a fullscreen server entrypoint with the exact called tool and its available metadata', async () => {
    const app: AppView = {
      ...MCP_APP,
      source: {
        kind: 'mcp',
        callId: 'goblin:entrypoint',
        connectionId: 'connector',
        tool: TOOL.name,
        uri: 'ui://media/view',
        entrypoint: true,
      },
    }
    const selected = await launchSelection(testQueryClient(), app, 'library')
    expect(selected).toMatchObject({
      kind: 'mcp',
      tool: {
        name: 'mymedia_media_view',
        inputSchema: { type: 'object' },
        title: 'Media',
        description: 'Show media',
      },
      arguments: { focus: 'library' },
      result: { content: [{ type: 'text', text: 'mymedia_media_view' }] },
    })
    expect(selected).not.toHaveProperty('requestId')
    expect(calls()).toEqual(['POST /api/mcp/connector/tools/call', 'GET /api/mcp/connector/tools'])
  })

  it('uses metadata already known for the exact tool on its originating connection', async () => {
    const client = testQueryClient()
    client.setQueryData(mcpKeys.tools('connector'), [TOOL, { ...TOOL, name: 'media_view', title: 'Bare' }])
    client.setQueryData(mcpKeys.tools('other'), [{ ...TOOL, title: 'Other connection' }])
    expect(await launchSelection(client, MCP_APP)).toMatchObject({
      tool: { name: TOOL.name, title: 'Media', description: 'Show media', inputSchema: { type: 'object' } },
    })
    expect(calls()).toEqual(['GET /api/apps/9/launch'])
  })

  it('loads an agent app without adding MCP tool information', async () => {
    const app: AppView = {
      ...MCP_APP,
      id: '7',
      source: { kind: 'agent', name: 'tapper', release: 'r_1', revision: 2, version: 1, jobs: [] },
    }
    expect(await launchSelection(testQueryClient(), app)).toEqual({ kind: 'agent', id: '7', launch: LAUNCH })
  })

  it('launch and read state fresh every time, never from the cache', async () => {
    const client = testQueryClient()
    expect(await client.query(appLaunchQuery('7'))).toEqual(LAUNCH)
    await perform(client, appCallMutation, { id: '7', call: { name: 'tap', arguments: {}, op: OP } })
    expect(await client.query(appLaunchQuery('7'))).toMatchObject({ revision: 3 })
    expect(await client.query(appStateQuery('7'))).toEqual({ revision: 3, release: 'r_1', state: { n: 3 } })
    expect(await client.query(appStateQuery('7'))).toMatchObject({ revision: 3 })
    expect(calls()).toEqual([
      'GET /api/apps/7/launch',
      'POST /api/apps/7/call',
      'GET /api/apps/7/launch',
      'GET /api/apps/7/state',
      'GET /api/apps/7/state',
    ])
  })

  it("carry an agent app's report and an MCP App's calls, the latter as the App", async () => {
    const client = testQueryClient()
    await perform(client, appDiagnosticMutation, { id: '7', message: 'TypeError: boom' })
    expect(fake.reports).toEqual(['TypeError: boom'])
    const result = await perform(client, appToolCallMutation, { connectionId: 'myplan', call: { name: 'read' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'read' }], extra: 'kept' })
    await perform(client, appResourceReadMutation, { connectionId: 'myplan', read: { uri: 'ui://myplan/app' } })
    expect(fake.callers).toEqual(['app', 'app'])
  })

  it('allow the asked tool, and the grants show it', async () => {
    const client = testQueryClient()
    await client.query(grantsQuery)
    const grants = await perform(client, toolGrantMutation, { connectionId: 'myplan', name: 'read', allowed: true })
    expect(grants).toEqual([{ connectionId: 'myplan', capability: 'tool', name: 'read' }])
    expect(client.getQueryData(grantsQuery.queryKey)).toEqual(grants)
  })

  it('read the server list again when a server is added but its connect fails, so its card shows', async () => {
    const client = testQueryClient()
    client.setQueryData(mcpKeys.servers, [])
    await expect(perform(client, addAndConnectMutation, { endpoint: 'https://mcp.kiwi.com' })).rejects.toBeInstanceOf(
      UpstreamMcp,
    )
    expect(client.getQueryState(mcpKeys.servers)?.isInvalidated).toBe(true)
  })

  it('fail with the typed refusal the owner sees', async () => {
    const client = testQueryClient()
    await expect(client.query(appLaunchQuery('8'))).rejects.toBeInstanceOf(NotFound)
  })
})
