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
import { Card, CardContent, CardHeader, CardTitle } from '@goblin/ui'
import { ActivityPage } from '../../src/components/shell/pages/activity-page.tsx'
import { TelegramControl, useTelegramChannel } from '../../src/components/telegram-control.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

/** The owner's Topics and the Persona that can answer a chat, as the workspace feed would hold them. */
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
      name: 'Travel',
      conversation: '20',
      searchExcluded: false,
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'owner',
      createdAt: 1,
    },
    {
      id: 3,
      name: 'Reading',
      conversation: '30',
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
      role: 'Plans trips',
      instructions: 'Plan well.',
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

const ignore = () => undefined

/** The Settings part of mysi's card on Connections, carrying the Telegram channel, as the server card renders it. */
function TelegramCard() {
  const channel = useTelegramChannel(ignore)
  return (
    <Card>
      <CardHeader>
        <CardTitle>mysi</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="server-body server-body-open">
          <section className="server-part" aria-label="Settings">
            <TelegramControl connectionId="mysi" channel={channel} />
          </section>
        </div>
      </CardContent>
    </Card>
  )
}

/** Connections' Telegram section at `/connections`, and Activity at `/activity`, on a memory router (`?at=`). */
const root = createRootRoute({
  component: () => (
    <main className="mx-auto max-w-3xl p-4">
      <Outlet />
    </main>
  ),
})
const connections = createRoute({ getParentRoute: () => root, path: '/connections', component: TelegramCard })
const activity = createRoute({ getParentRoute: () => root, path: '/activity', component: ActivityPage })
const router = createRouter({
  routeTree: root.addChildren([connections, activity]),
  history: createMemoryHistory({ initialEntries: [new URLSearchParams(location.search).get('at') ?? '/connections'] }),
})

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />, WORKSPACE))
