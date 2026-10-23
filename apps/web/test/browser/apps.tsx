import { createRoot } from 'react-dom/client'
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import { type AppView, EVERYTHING, type WorkspaceSnapshot } from '@goblin/contracts'
import { AppsPage } from '../../src/components/apps-page.tsx'
import { type Navigation, NavigationContext } from '../../src/lib/navigation.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/** A tool-result view kept in a conversation (the workspace feed's AppView). */
const view = (
  id: string,
  title: string,
  connectionId: string,
  tool: string,
  extra: Partial<AppView> = {},
): AppView => ({
  id,
  conversation: '20',
  title,
  createdAt: Number(id),
  source: { kind: 'mcp', callId: `call-${id}`, connectionId, tool, uri: `ui://${connectionId}/${tool}` },
  ...extra,
})

/** A populated workspace: Topics, a thread, pinned views and servers, recent views and a closed built app's view. */
const POPULATED: WorkspaceSnapshot = {
  conversations: [
    { id: '1', kind: 'main', keepOpen: false, replies: 4, createdAt: 1 },
    { id: '20', kind: 'thread', conversation: true, topic: 2, keepOpen: false, replies: 9, createdAt: 20 },
    {
      id: '21',
      kind: 'thread',
      parent: '20',
      topic: 2,
      title: 'Lisbon in May',
      keepOpen: false,
      replies: 3,
      createdAt: 21,
    },
  ],
  activity: [],
  apps: [
    view('31', 'Hotel results', 'trivago', 'hotels'),
    view('32', 'Flight options', 'kiwi', 'flights', { conversation: '21' }),
    view('33', 'Trip board', 'plan', 'board', { conversation: '21' }),
    view('34', 'Weather in Lisbon', 'weather', 'forecast', { conversation: '1' }),
    view('35', 'Closed map', 'maps', 'route', { closedAt: 40 }),
    {
      id: '40',
      conversation: '20',
      title: 'Trip tracker',
      createdAt: 40,
      closedAt: 41,
      source: { kind: 'agent', name: 'trips', release: 'r4', version: 4, revision: 17, jobs: [] },
    },
  ],
  topics: [
    {
      id: 1,
      name: 'Personal',
      conversation: '1',
      personal: true,
      reach: 'sealed',
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'system',
      createdAt: 1,
    },
    {
      id: 2,
      name: 'Travel',
      conversation: '20',
      reach: 'sealed',
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'owner',
      createdAt: 2,
    },
  ],
  sidebar: {
    revision: 3,
    pins: [
      { kind: 'server', connectionId: 'mysi' },
      { kind: 'view', appId: '33', title: 'Trip board' },
      { kind: 'server', connectionId: 'calendar-work' },
      { kind: 'view', appId: '99', title: 'Old receipt' },
    ],
  },
}

/** Nothing kept and nothing pinned. */
const EMPTY: WorkspaceSnapshot = { conversations: [], activity: [], apps: [], sidebar: { revision: 1, pins: [] } }

/** The shell's navigation: the build action's draft is left where the browser check reads it. */
const navigation: Navigation = {
  isAppPage: () => false,
  openApp: (app) => document.body.setAttribute('data-opened', app),
  closeAppPage: () => undefined,
  focusApp: () => undefined,
  newThreadWith: (draft, from) => document.body.setAttribute('data-asked', `${from}:${draft.text}`),
}

const empty = new URLSearchParams(location.search).has('empty')
const route = createRootRoute({
  component: () => (
    <NavigationContext value={navigation}>
      <main className="shell launcher-shell">
        <AppsPage />
      </main>
    </NavigationContext>
  ),
})
const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/apps'] }) })
const root = document.getElementById('root')
if (root) createRoot(root).render(withQueryClient(<RouterProvider router={router} />, empty ? EMPTY : POPULATED))
