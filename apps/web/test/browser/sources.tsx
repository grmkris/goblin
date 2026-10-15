import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { EVERYTHING, type ServerView, type WorkspaceSnapshot } from '@goblin/contracts'
import { Card, CardContent } from '@goblin/ui'
import { ConnectionSources } from '../../src/components/connection-sources.tsx'
import { NotifySinkCard } from '../../src/components/notify-sink-card.tsx'
import { ActivityPage } from '../../src/components/shell/pages/activity-page.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

/** A chat server's connection, connected and sending events, one of which it suggests a Source on (ADR 0066). */
const CHAT: ServerView = {
  connectionId: 'chat',
  label: 'Chat',
  endpoint: 'https://chat.example.com/mcp',
  status: 'connected',
  live: true,
  source: 'added',
  events: 'open',
}

/** The owner's Topics and a Persona that can answer a conversation, as the workspace feed would hold them. */
const WORKSPACE: WorkspaceSnapshot = {
  conversations: [],
  activity: [],
  apps: [],
  topics: [
    {
      id: 1,
      name: 'Personal',
      conversation: '1',
      personal: true,
      searchExcluded: false,
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'system',
      createdAt: 1,
    },
    {
      id: 2,
      name: 'Team',
      conversation: '20',
      searchExcluded: false,
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'owner',
      createdAt: 1,
    },
  ],
  personas: [
    {
      id: 7,
      name: 'Guide',
      avatar: { glyph: 'G', hue: 200 },
      role: 'Answers the team',
      instructions: 'Answer well.',
      setup: { mcpServers: [], skills: [], apps: [] },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  invocations: [],
  receipts: [],
}

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/** The Sources part of the chat server's card on Connections, as the server card renders it. */
function SourcesCard() {
  return (
    <Card>
      <CardContent>
        <div className="server-body server-body-open">
          <ConnectionSources server={CHAT} />
        </div>
      </CardContent>
    </Card>
  )
}

/** Connections' Sources at `/connections`, Activity at `/activity` and Notify me via at `/settings` (`?at=`). */
const root = createRootRoute({
  component: () => (
    <main className="mx-auto max-w-3xl p-4">
      <Outlet />
    </main>
  ),
})
const connections = createRoute({ getParentRoute: () => root, path: '/connections', component: SourcesCard })
const activity = createRoute({ getParentRoute: () => root, path: '/activity', component: ActivityPage })
const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: NotifySinkCard })
const router = createRouter({
  routeTree: root.addChildren([connections, activity, settings]),
  history: createMemoryHistory({ initialEntries: [new URLSearchParams(location.search).get('at') ?? '/connections'] }),
})

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />, WORKSPACE))
