import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { EVERYTHING, type WorkspaceSnapshot } from '@goblin/contracts'
import { AppHost } from '../../src/components/apps/host.tsx'
import { ChannelPage } from '../../src/components/shell/channel.tsx'
import { ShellNavigation } from '../../src/components/shell/navigation.tsx'
import { ShellFrame } from '../../src/components/shell/shell.tsx'
import { parsePanelSearch } from '../../src/lib/panel.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

const workspace: WorkspaceSnapshot = {
  conversations: [
    {
      id: '30',
      kind: 'main',
      title: 'Travel',
      conversation: true,
      topic: 2,
      keepOpen: false,
      replies: 2,
      createdAt: 1,
    },
    {
      id: '31',
      kind: 'thread',
      title: 'Hotel options',
      parent: '30',
      topic: 2,
      keepOpen: false,
      replies: 1,
      createdAt: 2,
    },
  ],
  topics: [
    {
      id: 2,
      name: 'Travel',
      conversation: '30',
      description: 'Plan a thoughtful week in Lisbon. Keep bookings, places and ideas together.',
      instructions:
        'Prefer walkable neighborhoods and locally owned places. Check dates and prices before recommending a booking.',
      reach: 'sealed',
      revision: 1,
      // One skill the library lists and one it no longer does.
      setup: {
        ...EVERYTHING,
        skills: [
          { connectionId: 'notes', name: 'trip-planning' },
          { connectionId: 'notes', name: 'packing-list' },
        ],
      },
      createdBy: 'owner',
      createdAt: 1,
    },
  ],
  activity: [],
  apps: [],
  personas: [],
  invocations: [],
  receipts: [],
  notifications: [],
  sidebar: { revision: 0, pins: [] },
}
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
const root = createRootRoute({
  component: () => (
    <ShellNavigation>
      <ShellFrame>
        <AppHost>
          <Outlet />
        </AppHost>
      </ShellFrame>
    </ShellNavigation>
  ),
})
const channel = createRoute({
  getParentRoute: () => root,
  path: '/c/$chatId',
  validateSearch: parsePanelSearch,
  component: function Channel() {
    return <ChannelPage chat={channel.useParams().chatId} search={channel.useSearch()} />
  },
})
const router = createRouter({
  routeTree: root.addChildren([channel]),
  history: createMemoryHistory({ initialEntries: [new URLSearchParams(location.search).get('at') ?? '/c/30'] }),
})
const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />, workspace))
