import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import { renderToString } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type AgentAppSummary,
  type AppView,
  type ConversationView,
  EVERYTHING,
  type ServerView,
  type SidebarPins,
  type TopicView,
} from '@goblin/contracts'
import { agentAppsQuery } from '../src/agent-apps/queries.ts'
import { healthQuery } from '../src/auth/queries.ts'
import { AppsPage } from '../src/components/apps-page.tsx'
import { WorkspaceFeedProvider } from '../src/components/workspace-feed.tsx'
import { owner } from '../src/lib/api.ts'
import { type Navigation, NavigationContext } from '../src/lib/navigation.ts'
import { workspaceQueries } from '../src/lib/workspace/sync.ts'
import { serversQuery } from '../src/mcp/queries.ts'
import { testQueryClient } from './query/testing.ts'

/** What reached the network: the page reads what its route primed, and nothing while it renders. */
const requests: string[] = []
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', (input: Request) => {
    requests.push(new URL(input.url).pathname)
    return new Promise<never>(() => undefined)
  })
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
})

/** The shell's navigation, which Apps asks to start a thread with the build request; nothing navigates here. */
const navigation: Navigation = {
  isAppPage: () => false,
  openApp: () => undefined,
  closeAppPage: () => undefined,
  focusApp: () => undefined,
  newThreadWith: () => undefined,
}

/** Apps as the owner's browser draws it first, inside a router at `/apps` and the shell's navigation. */
async function page(client: ReturnType<typeof testQueryClient>): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NavigationContext value={navigation}>
          <AppsPage />
        </NavigationContext>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/apps'] }),
  })
  await router.load()
  return renderToString(
    <QueryClientProvider client={client}>
      <WorkspaceFeedProvider enabled={false}>
        <RouterProvider router={router} />
      </WorkspaceFeedProvider>
    </QueryClientProvider>,
  )
}

const server = (connectionId: string, overrides: Partial<ServerView> = {}): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status: 'connected',
  live: true,
  source: 'config',
  ...overrides,
})
const SERVERS = [
  server('bank', { title: 'Bank', entrypoint: 'open' }),
  server('calendar-work', { label: 'Work', title: 'Calendar', status: 'needs_auth', entrypoint: 'home' }),
  server('search', { title: 'Search' }),
]

const built = (name: string, overrides: Partial<AgentAppSummary> = {}): AgentAppSummary => ({
  name,
  title: name,
  description: '',
  home: '20',
  app: null,
  version: 4,
  revision: 17,
  jobs: [],
  waiting: 0,
  failure: null,
  updatedAt: 1,
  ...overrides,
})
const BUILT = [
  built('trips', { title: 'Trip tracker', description: 'Flights and hotels for your trips.', app: '8', waiting: 2 }),
  built('digest', {
    title: 'Morning digest',
    jobs: [
      {
        action: 'send',
        every: '1d',
        at: '07:00',
        nextAt: 0,
        lastAt: null,
        status: null,
        error: null,
        failures: 0,
        paused: null,
      },
    ],
  }),
]

const view = (id: string, overrides: Partial<AppView> = {}): AppView => ({
  id,
  conversation: '20',
  title: 'Hotel results',
  createdAt: Number(id),
  source: { kind: 'mcp', callId: `call-${id}`, connectionId: 'travel', tool: 'hotels', uri: 'ui://travel/hotels' },
  ...overrides,
})
const APPS = [
  view('5'),
  view('7', {
    conversation: '21',
    title: 'Trip board',
    source: { kind: 'mcp', callId: 'call-7', connectionId: 'travel', tool: 'board', uri: 'ui://travel/board' },
  }),
  {
    id: '8',
    conversation: '20',
    title: 'Trip tracker',
    createdAt: 8,
    closedAt: 9,
    source: { kind: 'agent', name: 'trips', release: 'r4', version: 4, revision: 17, jobs: [] },
  } satisfies AppView,
]
const PINS: SidebarPins = {
  revision: 2,
  pins: [
    { kind: 'view', appId: '7', title: 'Trip board' },
    { kind: 'server', connectionId: 'calendar-work' },
  ],
}
const TOPICS: readonly TopicView[] = [
  {
    id: 2,
    name: 'Travel',
    conversation: '20',
    searchExcluded: false,
    revision: 1,
    setup: EVERYTHING,
    createdBy: 'owner',
    createdAt: 2,
  },
]
const CHATS: readonly ConversationView[] = [
  { id: '20', kind: 'thread', conversation: true, topic: 2, keepOpen: false, replies: 3, createdAt: 20 },
  { id: '21', kind: 'thread', parent: '20', topic: 2, title: 'Lisbon', keepOpen: false, replies: 1, createdAt: 21 },
]

/** The workspace as the feed's first snapshot left it. */
function workspace(
  client: ReturnType<typeof testQueryClient>,
  { apps = APPS, pins = PINS }: { readonly apps?: readonly AppView[]; readonly pins?: SidebarPins } = {},
) {
  client.setQueryData(workspaceQueries.apps.queryKey, apps)
  client.setQueryData(workspaceQueries.sidebar.queryKey, pins)
  client.setQueryData(workspaceQueries.topics.queryKey, TOPICS)
  client.setQueryData(workspaceQueries.conversations.queryKey, CHATS)
}

/** Whether built apps are on here, as /health says. */
const features = (client: ReturnType<typeof testQueryClient>, agentApps: boolean) =>
  client.setQueryData(healthQuery.queryKey, {
    signup: 'closed',
    methods: { email: true },
    features: { largeFiles: false, agentApps, flows: false },
  })

/** A read that failed, as an observer that already saw it fail finds it (it does not read again on mount). */
async function failed(client: ReturnType<typeof testQueryClient>, queryKey: readonly unknown[]) {
  client.setQueryDefaults(queryKey, { retryOnMount: false })
  await client
    .query({ queryKey, queryFn: () => Promise.reject(new TypeError('offline')) })
    // expected: the read fails, which is what the page is shown with
    .catch(() => undefined)
}

const headings = (markup: string) => [...markup.matchAll(/<h2 id="[a-z]+-title">([^<]+)<\/h2>/gu)].map(([, h]) => h)

describe('the Apps launcher (ADR 0078)', () => {
  it('shows Pinned, Recent, Connected and Built for you in order, each with its own action', async () => {
    const client = testQueryClient()
    workspace(client)
    client.setQueryData(serversQuery.queryKey, SERVERS)
    client.setQueryData(agentAppsQuery.queryKey, BUILT)
    const markup = await page(client)
    expect(headings(markup)).toEqual(['Pinned', 'Recent', 'Connected', 'Built for you'])
    // Pinned: a view from its thread, and a signed-out server kept in place by its label with Reconnect.
    expect(markup).toContain('From Lisbon')
    expect(markup).toContain(
      '<h3 class="launcher-name">Calendar</h3><p class="launcher-meta">Work</p><p class="launcher-meta">Signed out</p>',
    )
    expect(markup).toContain('Reconnect')
    // Recent: the unpinned view and its channel; the pinned one is not repeated there.
    expect(markup).toContain('Hotel results')
    expect(markup).toContain('From #Travel')
    expect(markup).toContain('href="/a/5"')
    // Connected: the connection's own App opens; a server with tools only is not listed.
    expect(markup).toContain('href="/connections/bank/app"')
    expect(markup).not.toContain('/connections/search/app')
    // Built for you: Open beside Manage, Manage alone without a view, what it needs, and no version.
    expect(markup).toContain('aria-label="Open Trip tracker"')
    expect(markup).toContain('href="/apps/trips"')
    expect(markup).toContain('href="/apps/digest"')
    expect(markup).toContain('2 to allow')
    expect(markup).toContain('Runs in the background')
    expect(markup).not.toMatch(/>v\d/u)
    expect(markup).not.toContain('No apps yet')
    expect(requests).toEqual([])
  })

  it('keeps the other sections when the built apps could not be read, and does not say there are none', async () => {
    const client = testQueryClient()
    workspace(client, { apps: [], pins: { revision: 1, pins: [] } })
    client.setQueryData(serversQuery.queryKey, SERVERS)
    await failed(client, agentAppsQuery.queryKey)
    const markup = await page(client)
    expect(headings(markup)).toEqual(['Connected', 'Built for you'])
    expect(markup).toContain('href="/connections/bank/app"')
    expect(markup).toContain('Could not load the apps built for you.')
    expect(markup).toContain('Try again')
    expect(markup).not.toContain('No apps yet')
    expect(markup).not.toContain('Ask goblin to build an app')
  })

  it('without built apps here, hides Built for you and its build action and keeps the rest', async () => {
    const client = testQueryClient()
    features(client, false)
    workspace(client)
    client.setQueryData(serversQuery.queryKey, SERVERS)
    const markup = await page(client)
    expect(headings(markup)).toEqual(['Pinned', 'Recent', 'Connected'])
    expect(markup).not.toContain('Ask goblin to build an app')
    const none = testQueryClient()
    features(none, false)
    workspace(none, { apps: [], pins: { revision: 1, pins: [] } })
    none.setQueryData(serversQuery.queryKey, [])
    const empty = await page(none)
    expect(empty).toContain('No apps yet')
    expect(empty).not.toContain('Ask goblin to build an app')
  })

  it('with no app at all, points to Add a connection and offers to build one', async () => {
    const client = testQueryClient()
    workspace(client, { apps: [], pins: { revision: 1, pins: [] } })
    client.setQueryData(serversQuery.queryKey, [server('search', { title: 'Search' })])
    client.setQueryData(agentAppsQuery.queryKey, [])
    const markup = await page(client)
    expect(markup).toContain('No apps yet')
    expect(markup).toContain('href="/connections"')
    expect(markup).toContain('Ask goblin to build an app')
    expect(headings(markup)).toEqual([])
  })

  it('offers to build an app in Built for you when the others have some', async () => {
    const client = testQueryClient()
    workspace(client, { apps: [], pins: { revision: 1, pins: [] } })
    client.setQueryData(serversQuery.queryKey, SERVERS)
    client.setQueryData(agentAppsQuery.queryKey, [])
    const markup = await page(client)
    expect(headings(markup)).toEqual(['Connected', 'Built for you'])
    expect(markup).toContain('Ask goblin to build an app')
    expect(markup).not.toContain('No apps yet')
  })

  it('keeps each section’s place while its source is read, and says nothing is there only once all are read', async () => {
    const markup = await page(testQueryClient())
    expect(headings(markup)).toEqual(['Pinned', 'Recent', 'Connected', 'Built for you'])
    expect(markup).toContain('data-slot="skeleton"')
    expect(markup).not.toContain('No apps yet')
  })
})
