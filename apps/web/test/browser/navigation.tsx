import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { type AppView, type ConversationView, EVERYTHING, type WorkspaceSnapshot } from '@goblin/contracts'
import { PageBar } from '../../src/components/page-bar.tsx'
import { ActivityPage } from '../../src/components/shell/pages/activity-page.tsx'
import { PersonasPage } from '../../src/components/shell/pages/personas-page.tsx'
import { ShellNavigation } from '../../src/components/shell/navigation.tsx'
import { ShellFrame } from '../../src/components/shell/shell.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

const NOW = Math.floor(Date.now() / 1000)

const chat = (id: string, overrides: Partial<ConversationView>): ConversationView => ({
  id,
  kind: 'thread',
  keepOpen: false,
  replies: 0,
  createdAt: NOW - 3600,
  ...overrides,
})

const mcpView = (id: string, conversation: string, title: string, overrides: Partial<AppView> = {}): AppView => ({
  id,
  conversation,
  title,
  createdAt: NOW - Number(id),
  source: { kind: 'mcp', callId: `call-${id}`, connectionId: 'trivago', tool: `tool-${id}`, uri: `ui://trivago/${id}` },
  ...overrides,
})

/**
 * An owner with three Topics (one archived), threads (one unread, one a Delegate at work), pins in every state, an agent
 * app, recent App views, two Personas and an unread notification: every row and count the sidebar draws.
 */
const WORKSPACE: WorkspaceSnapshot = {
  conversations: [
    chat('1', { kind: 'main', title: 'Personal', conversation: true }),
    chat('30', { kind: 'main', title: 'Travel', conversation: true, topic: 2 }),
    chat('31', {
      parent: '30',
      title: 'Hotel options in Lisbon',
      replies: 4,
      lastReplyAt: NOW - 60,
      readAt: NOW - 600,
    }),
    chat('32', { parent: '1', title: 'Weekend plan', replies: 2, lastReplyAt: NOW - 900, readAt: NOW - 800 }),
    chat('40', { kind: 'subagent', parent: '1', title: 'Compare flights' }),
  ],
  activity: [{ id: '40', state: 'working', since: NOW - 30 }],
  apps: [
    mcpView('7', '31', 'Hotel results'),
    mcpView('11', '32', 'Weather this weekend', {
      source: { kind: 'mcp', callId: 'call-11', connectionId: 'weather', tool: 'forecast', uri: 'ui://weather/f' },
    }),
    mcpView('10', '1', 'Old board', { closedAt: NOW - 100 }),
    mcpView('8', '33', 'mysi', {
      source: {
        kind: 'mcp',
        callId: 'call-8',
        connectionId: 'mysi',
        tool: 'open',
        uri: 'ui://mysi/home',
        entrypoint: true,
      },
    }),
    {
      id: '9',
      conversation: '1',
      title: 'Trip tracker',
      createdAt: NOW - 9,
      source: {
        kind: 'agent',
        name: 'trip-tracker',
        release: 'r1',
        version: 3,
        revision: 12,
        jobs: [
          {
            action: 'refresh',
            every: '1d',
            at: '08:00',
            nextAt: NOW + 3600,
            lastAt: NOW - 3600,
            status: 'failed',
            error: 'The airline did not answer',
            failures: 3,
            paused: 'failures',
          },
        ],
      },
    },
  ],
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
      conversation: '30',
      searchExcluded: false,
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'owner',
      createdAt: 2,
    },
    {
      id: 3,
      name: 'Old project',
      conversation: '50',
      searchExcluded: false,
      archivedAt: NOW - 86_400,
      revision: 0,
      setup: EVERYTHING,
      createdBy: 'owner',
      createdAt: 3,
    },
  ],
  personas: [
    {
      id: 7,
      name: 'guide',
      avatar: { glyph: 'G', hue: 200 },
      role: 'Plans trips and checks the details',
      instructions: 'Plan well.',
      setup: { mcpServers: [], skills: [], apps: [] },
      revision: 2,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 8,
      name: 'critic',
      avatar: { glyph: 'C', hue: 20 },
      role: 'Finds what is wrong with a plan',
      instructions: 'Be honest.',
      setup: { mcpServers: [], skills: [], apps: [] },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 9,
      name: 'old-helper',
      avatar: { glyph: 'O', hue: 120 },
      role: 'No longer used',
      instructions: 'Retired.',
      setup: { mcpServers: [], skills: [], apps: [] },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: NOW - 100,
    },
  ],
  invocations: [],
  receipts: [],
  notifications: [
    {
      id: 'n1',
      source: 'reminder',
      chat: '1',
      label: 'Reminder',
      title: 'Check in for the flight',
      at: NOW,
      readAt: null,
    },
  ],
  sidebar: {
    revision: 3,
    pins: [
      { kind: 'server', connectionId: 'mysi' },
      { kind: 'view', appId: '9', title: 'Trip tracker' },
      { kind: 'view', appId: '10', title: 'Old board' },
      { kind: 'server', connectionId: 'cloud' },
    ],
  },
}

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/** A page of the fixture: its bar (with the phone's navigation button) and what it shows. */
function Page({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <>
      <PageBar title={title} />
      <div className="shell">{children ?? <p className="page-empty">{title}</p>}</div>
    </>
  )
}

const root = createRootRoute({
  component: () => (
    <ShellNavigation>
      <ShellFrame>
        <Outlet />
      </ShellFrame>
    </ShellNavigation>
  ),
})
const page = (path: string, title: string, body?: () => ReactNode) =>
  createRoute({
    getParentRoute: () => root,
    path,
    component: () => <Page title={title}>{body?.()}</Page>,
  })
const channel = createRoute({
  getParentRoute: () => root,
  path: '/c/$chatId',
  validateSearch: (search: Record<string, unknown>): { thread?: number } =>
    typeof search.thread === 'number' ? { thread: search.thread } : {},
  component: () => <Page title="Channel" />,
})
const router = createRouter({
  routeTree: root.addChildren([
    channel,
    page('/threads', 'All threads'),
    page('/activity', 'Activity', () => <ActivityPage />),
    page('/work', 'Work'),
    page('/apps', 'Apps'),
    page('/apps/$name', 'Manage app'),
    page('/a/$appId', 'App'),
    page('/connections', 'Connections'),
    page('/connections/$connectionId/app', 'Server app'),
    page('/personas', 'Personas', () => <PersonasPage />),
    page('/p/$id', 'Persona'),
    page('/settings', 'Settings'),
  ]),
  history: createMemoryHistory({ initialEntries: [new URLSearchParams(location.search).get('at') ?? '/c/1'] }),
})

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />, WORKSPACE))
