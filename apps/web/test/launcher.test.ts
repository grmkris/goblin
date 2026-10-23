import { describe, expect, it } from 'vitest'
import {
  type AgentAppSummary,
  type AppView,
  type ConversationView,
  EVERYTHING,
  type ServerView,
  type SidebarTarget,
  type TopicView,
  pinKey,
} from '@goblin/contracts'
import {
  cameFrom,
  connectedApps,
  matches,
  needsYou,
  pinAction,
  pinConnection,
  pinNote,
  recentViews,
} from '../src/lib/launcher.ts'

const server = (connectionId: string, overrides: Partial<ServerView> = {}): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status: 'connected',
  live: true,
  source: 'config',
  ...overrides,
})

/** A tool-result view kept from `tool` on `connectionId`, made at `createdAt`. */
const view = (id: string, tool: string, overrides: Partial<AppView> = {}, connectionId = 'travel'): AppView => ({
  id,
  conversation: '20',
  title: tool,
  createdAt: Number(id),
  source: { kind: 'mcp', callId: `call-${id}`, connectionId, tool, uri: `ui://${connectionId}/${tool}` },
  ...overrides,
})

const pinned =
  (...appIds: readonly string[]) =>
  (target: SidebarTarget) =>
    appIds.some((appId) => pinKey({ kind: 'view', appId }) === pinKey(target))
const none = pinned()
const ids = (apps: readonly AppView[]) => apps.map((app) => app.id)

describe('Recent in Apps (ADR 0078)', () => {
  it('lists open tool-result views newest first, the newest of each connection’s tool alone', () => {
    const apps = [
      view('1', 'hotels'),
      view('2', 'flights'),
      view('3', 'hotels'),
      view('4', 'hotels', {}, 'other-account'),
    ]
    expect(ids(recentViews(apps, none))).toEqual(['4', '3', '2'])
  })

  it('leaves out closed, pinned, built apps and a server’s own App, and then shows the next newest of that tool', () => {
    const own = view('9', 'open', {
      source: { kind: 'mcp', callId: 'c9', connectionId: 'notes', tool: 'open', uri: 'ui://n', entrypoint: true },
    })
    const built: AppView = {
      id: '8',
      conversation: '1',
      title: 'Trip tracker',
      createdAt: 8,
      source: { kind: 'agent', name: 'trips', release: 'r1', version: 1, revision: 0, jobs: [] },
    }
    const apps = [own, built, view('7', 'hotels', { closedAt: 10 }), view('6', 'hotels'), view('5', 'flights')]
    expect(ids(recentViews(apps, pinned('5')))).toEqual(['6'])
  })

  it('stops at six', () => {
    const apps = Array.from({ length: 9 }, (_, index) => view(String(index + 1), `tool${index}`))
    expect(ids(recentViews(apps, none))).toEqual(['9', '8', '7', '6', '5', '4'])
  })
})

describe('Connected in Apps (ADR 0078)', () => {
  it('lists every connection with an App of its own, signed in or not, by its title, falling back to its label', () => {
    const listed = connectedApps([
      server('bank', { entrypoint: 'open', title: 'Bank' }),
      server('calendar-work', { entrypoint: 'home', label: 'Work', title: 'Calendar', status: 'needs_auth' }),
      server('calendar-home', { entrypoint: 'home', label: 'Home', title: 'Calendar', status: 'disconnected' }),
      server('notes', { entrypoint: 'home', label: 'My notes' }),
    ])
    expect(listed).toEqual([
      { connectionId: 'bank', title: 'Bank', label: 'bank', connected: true },
      { connectionId: 'calendar-work', title: 'Calendar', label: 'Work', connected: false },
      { connectionId: 'calendar-home', title: 'Calendar', label: 'Home', connected: false },
      { connectionId: 'notes', title: 'My notes', label: 'My notes', connected: true },
    ])
  })

  it('leaves out a connection whose server has tools and no App of its own', () => {
    expect(connectedApps([server('search'), server('browser', { status: 'needs_auth' })])).toEqual([])
  })
})

describe('searching Apps', () => {
  it('finds an item by its name or its connection’s label, in any case; nothing typed finds everything', () => {
    expect(matches('', 'Trip tracker')).toBe(true)
    expect(matches('  TRIP ', 'Trip tracker')).toBe(true)
    expect(matches('work', 'Calendar', 'Work account')).toBe(true)
    expect(matches('hotel', 'Calendar', 'Work account')).toBe(false)
  })

  it('names the connection a pin is found by: its server, or its view’s server; a built app’s view has none', () => {
    expect(pinConnection({ kind: 'server', connectionId: 'notes', title: 'Notes', state: 'ready' })).toBe('notes')
    const app = view('3', 'hotels')
    expect(pinConnection({ kind: 'view', appId: '3', title: 'Hotels', app, state: 'ready' })).toBe('travel')
    expect(pinConnection({ kind: 'view', appId: '4', title: 'Gone', app: undefined, state: 'gone' })).toBeUndefined()
  })
})

describe('a pin in Apps', () => {
  it('opens when it is ready or still being read, opens a closed view again, and reconnects a signed-out server', () => {
    expect(pinAction('ready')).toBe('open')
    expect(pinAction('loading')).toBe('open')
    expect(pinAction('closed')).toBe('reopen')
    expect(pinAction('signed-out')).toBe('reconnect')
    expect(pinAction('no-app')).toBeUndefined()
    expect(pinAction('gone')).toBeUndefined()
  })

  it('says why it does not open as it is, and nothing when it does', () => {
    expect(pinNote('ready')).toBeUndefined()
    expect(pinNote('loading')).toBeUndefined()
    expect(pinNote('signed-out')).toBe('Signed out')
    expect(pinNote('no-app')).toBe('No app any more')
    expect(pinNote('closed')).toBe('Closed')
    expect(pinNote('gone')).toBe('Not available')
  })
})

const topic = (id: number, name: string, conversation: string): TopicView => ({
  id,
  name,
  conversation,
  reach: 'sealed',
  revision: 1,
  setup: EVERYTHING,
  createdBy: 'owner',
  createdAt: id,
})
const chat = (id: string, overrides: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  keepOpen: false,
  replies: 1,
  createdAt: Number(id),
  ...overrides,
})

describe('where a view came from', () => {
  const topics = [topic(1, 'Personal', '1'), topic(2, 'Travel', '20')]
  const views = [
    chat('1', { kind: 'main' }),
    chat('20', { conversation: true, topic: 2 }),
    chat('21', { parent: '20', topic: 2, title: 'Lisbon hotels' }),
    chat('22', { parent: '20', topic: 2 }),
  ]

  it('names its channel, or its thread by title, or the thread’s channel when it has none', () => {
    expect(cameFrom('20', views, topics)).toBe('From #Travel')
    expect(cameFrom('1', views, topics)).toBe('From #Personal')
    expect(cameFrom('21', views, topics)).toBe('From Lisbon hotels')
    expect(cameFrom('22', views, topics)).toBe('From a thread in #Travel')
  })

  it('says nothing for a conversation the feed does not list', () => {
    expect(cameFrom('99', views, topics)).toBeUndefined()
  })
})

const builtApp = (overrides: Partial<AgentAppSummary> = {}): AgentAppSummary => ({
  name: 'trips',
  title: 'Trip tracker',
  description: 'Flights and hotels',
  home: '20',
  app: '8',
  version: 3,
  revision: 12,
  jobs: [],
  waiting: 0,
  failure: null,
  updatedAt: 1,
  ...overrides,
})

describe('what a built app needs from the owner', () => {
  it('names powers to allow first, then a schedule in trouble, then a failure, and nothing otherwise', () => {
    const failed = {
      action: 'refresh',
      every: '1h',
      at: null,
      nextAt: 0,
      lastAt: 0,
      status: 'failed',
      error: 'timeout',
      failures: 3,
      paused: 'failures',
    } as const
    expect(needsYou(builtApp({ waiting: 2, jobs: [failed], failure: 'boom' }))).toBe('2 to allow')
    expect(needsYou(builtApp({ jobs: [failed], failure: 'boom' }))).toBe('Schedule needs you')
    expect(needsYou(builtApp({ failure: 'boom' }))).toBe('Failing')
    expect(needsYou(builtApp())).toBeUndefined()
  })
})
