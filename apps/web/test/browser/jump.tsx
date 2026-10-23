import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from '@tanstack/react-router'
import { type ConversationView, EVERYTHING, type TopicView, type WorkspaceSnapshot } from '@goblin/contracts'
import { JumpToButton, JumpToProvider } from '../../src/components/shell/jump-to.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

const topic = (id: number, name: string, conversation: string, extra: Partial<TopicView> = {}): TopicView => ({
  id,
  name,
  conversation,
  reach: 'sealed',
  revision: 1,
  setup: EVERYTHING,
  createdBy: 'owner',
  createdAt: id,
  ...extra,
})
const thread = (
  id: string,
  parent: string,
  title: string,
  extra: Partial<ConversationView> = {},
): ConversationView => ({
  id,
  kind: 'thread',
  parent,
  title,
  keepOpen: false,
  replies: 2,
  createdAt: Number(id),
  ...extra,
})

/** An owner with three Topics, open threads in two of them, a Persona and two pins (a service's App and one view). */
const WORKSPACE: WorkspaceSnapshot = {
  conversations: [
    { id: '1', kind: 'main', conversation: true, keepOpen: true, replies: 0, createdAt: 1 },
    { id: '20', kind: 'main', conversation: true, keepOpen: true, replies: 0, createdAt: 2, topic: 2 },
    { id: '30', kind: 'main', conversation: true, keepOpen: true, replies: 0, createdAt: 3, topic: 3 },
    thread('21', '20', 'Hotels in Kyoto near the station'),
    thread('22', '20', 'Flights to Osaka', { lastReplyAt: 40, readAt: 10 }),
    thread('23', '1', 'Weekly groceries'),
    thread('24', '30', 'Quarterly VAT return for the café, with every receipt since July'),
  ],
  activity: [],
  apps: [
    {
      id: '7',
      conversation: '20',
      title: 'Hotel board',
      createdAt: 7,
      source: { kind: 'mcp', callId: 'call-7', connectionId: 'mysi', tool: 'board', uri: 'ui://mysi/board' },
    },
  ],
  topics: [topic(1, 'Personal', '1', { personal: true }), topic(2, 'Travel', '20'), topic(3, 'Taxes', '30')],
  personas: [
    {
      id: 5,
      name: 'sage',
      avatar: { glyph: 'S', hue: 120 },
      role: 'Helps',
      instructions: 'Help.',
      setup: { mcpServers: [], skills: [], apps: [] },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  invocations: [],
  receipts: [],
  sidebar: {
    revision: 2,
    pins: [
      { kind: 'server', connectionId: 'mysi' },
      { kind: 'view', appId: '7', title: 'Hotel board' },
    ],
  },
}

/** Where the router is now, so the browser test can read where a jump went. */
function Location() {
  const href = useRouterState({ select: (router) => router.location.href })
  return <output aria-label="Location">{href}</output>
}

/** The real switcher around a stand-in shell: the sidebar's Jump to row, and a message field to take focus from. */
const root = createRootRoute({
  component: () => (
    <JumpToProvider>
      <div style={{ display: 'flex', minHeight: '100dvh' }}>
        <nav
          className="shell-sidebar"
          aria-label="Places"
          style={{ flex: 'none', width: 'min(17rem, 55vw)', padding: '0.5rem' }}
        >
          <JumpToButton />
        </nav>
        <main style={{ flex: 1, minWidth: 0, padding: '1rem', display: 'grid', alignContent: 'start', gap: '0.75rem' }}>
          <Location />
          <textarea aria-label="Message" rows={3} style={{ width: '100%', minWidth: 0 }} />
          <Outlet />
        </main>
      </div>
    </JumpToProvider>
  ),
})
const anywhere = createRoute({ getParentRoute: () => root, path: '$' })
const router = createRouter({
  routeTree: root.addChildren([anywhere]),
  history: createMemoryHistory({ initialEntries: ['/c/1'] }),
})

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />, WORKSPACE))
