import { describe, expect, it } from 'vitest'
import {
  type AgentAppSummary,
  type AppView,
  type ConversationView,
  EVERYTHING,
  type PersonaView,
  type ServerView,
  type TopicView,
} from '@goblin/contracts'
import { type JumpItem, type JumpSources, jumpItems, jumpResults } from '../src/lib/jump.ts'
import type { ShownPin } from '../src/lib/pins.ts'

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
const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  keepOpen: false,
  replies: 1,
  createdAt: Number(id),
  ...extra,
})
const persona = (id: number, name: string, archivedAt?: number): PersonaView => ({
  id,
  name,
  avatar: { glyph: name[0] ?? 'P', hue: 120 },
  role: 'Helps',
  instructions: 'Help.',
  setup: { mcpServers: [], skills: [], apps: [] },
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...(archivedAt !== undefined && { archivedAt }),
})
const server = (connectionId: string, overrides: Partial<ServerView> = {}): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status: 'connected',
  live: true,
  source: 'config',
  entrypoint: 'open',
  ...overrides,
})
const built = (name: string, app: string | null): AgentAppSummary => ({
  name,
  title: `${name} app`,
  description: '',
  home: '1',
  app,
  version: 1,
  revision: 1,
  jobs: [],
  waiting: 0,
  failure: null,
  updatedAt: 1,
})
const boardView: AppView = {
  id: '7',
  conversation: '20',
  title: 'Hotel board',
  createdAt: 7,
  source: { kind: 'mcp', callId: 'call-7', connectionId: 'mysi', tool: 'board', uri: 'ui://mysi/board' },
}

const TOPICS = [
  topic(1, 'Personal', '1', { personal: true }),
  topic(2, 'Travel', '20'),
  topic(3, 'Taxes', '30', { archivedAt: 9 }),
]
const VIEWS = [
  view('1', { kind: 'main', conversation: true, parent: undefined }),
  view('20', { kind: 'main', conversation: true, parent: undefined, topic: 2 }),
  view('21', { parent: '20', title: 'Hotels in Kyoto', createdAt: 21 }),
  view('22', { parent: '20', title: 'Flights', createdAt: 22, lastReplyAt: 30, readAt: 10 }),
  view('23', { parent: '1', title: 'Closed one', closedAt: 5 }),
  view('24', { parent: '21', title: 'Ryokan options', createdAt: 24 }),
]
const sources = (extra: Partial<JumpSources> = {}): JumpSources => ({
  topics: TOPICS,
  views: VIEWS,
  personas: [persona(5, 'sage'), persona(6, 'gone', 3)],
  pins: [],
  servers: [server('mysi', { title: 'mysi' }), server('notes', { status: 'needs_auth' })],
  built: [built('tracker', '40'), built('draft', null)],
  agentApps: true,
  ...extra,
})
const of = (items: readonly JumpItem[], kind: JumpItem['kind']) => items.filter((item) => item.kind === kind)
const rows = (items: readonly JumpItem[]) => items.map((item) => `${item.label} — ${item.detail}`)

describe('the places Jump to lists', () => {
  it('lists the pages, the Apps page only where the deployment has agent apps', () => {
    expect(of(jumpItems(sources()), 'destination').map((item) => item.link.to)).toEqual([
      '/activity',
      '/work',
      '/apps',
      '/connections',
      '/personas',
      '/settings',
      '/threads',
    ])
    // Apps stays without agent apps (ADR 0078): it still holds the pins, recent views and connected apps.
    const without = jumpItems(sources({ agentApps: false }))
    expect(of(without, 'destination').map((item) => item.label)).toContain('Apps')
    expect(rows(of(without, 'app'))).toEqual(['mysi — App · Connected'])
  })

  it('lists the active Topics, Personal first, each opening its channel', () => {
    const topics = of(jumpItems(sources()), 'topic')
    expect(rows(topics)).toEqual(['Personal — Topic', 'Travel — Topic'])
    expect(topics[1]?.link).toEqual({ to: '/c/$chatId', params: { chatId: '20' } })
  })

  it('lists the open threads, unread first, each in its Topic’s channel with its panel', () => {
    const threads = of(jumpItems(sources()), 'thread')
    expect(rows(threads)).toEqual([
      'Flights — Thread in #Travel',
      'Ryokan options — Thread in #Travel',
      'Hotels in Kyoto — Thread in #Travel',
    ])
    expect(threads[1]?.link).toEqual({ to: '/c/$chatId', params: { chatId: '20' }, search: { thread: 24 } })
  })

  it('lists the pins first, then the connected services’ own Apps, then the built ones, each once', () => {
    const pins: ShownPin[] = [
      { kind: 'view', appId: '7', title: 'Hotel board', app: boardView, state: 'ready' },
      { kind: 'server', connectionId: 'mysi', title: 'mysi', state: 'ready' },
      { kind: 'view', appId: '8', title: 'Removed', app: undefined, state: 'gone' },
      { kind: 'server', connectionId: 'tools', title: 'tools', state: 'no-app' },
    ]
    const apps = of(jumpItems(sources({ pins })), 'app')
    expect(rows(apps)).toEqual([
      'Hotel board — App · mysi',
      'mysi — App · Pinned',
      'tracker app — App · Built for you',
      'draft app — App · Built for you',
    ])
    expect(apps.map((item) => item.link)).toEqual([
      { to: '/a/$appId', params: { appId: '7' } },
      { to: '/connections/$connectionId/app', params: { connectionId: 'mysi' } },
      { to: '/a/$appId', params: { appId: '40' } },
      { to: '/apps/$name', params: { name: 'draft' } },
    ])
    expect(apps.map((item) => item.tile)).toEqual(['mysi', 'mysi', 'tracker', 'draft'])
  })

  it("lists a key's rooms after the Topics, by key, found by a query but not before one is typed", () => {
    const rooms = [
      topic(4, 'deal-4', '40', { madeBy: { key: 'swarmm-prod' } }),
      topic(5, 'deal-5', '50', { madeBy: { key: 'swarmm-prod' }, archivedAt: 9 }),
    ]
    const items = jumpItems(sources({ topics: [...TOPICS, ...rooms] }))
    expect(rows(of(items, 'topic'))).toEqual(['Personal — Topic', 'Travel — Topic', 'deal-4 — Room of swarmm-prod'])
    expect(ranked(items, '')).toEqual(ranked(jumpItems(sources()), ''))
    expect(ranked(items, 'deal')).toEqual(['Topics: deal-4'])
  })

  it('lists fewer Apps, never none of the rest, while the servers and built apps are not read', () => {
    const items = jumpItems(sources({ servers: undefined, built: undefined }))
    expect(of(items, 'app')).toEqual([])
    expect(of(items, 'topic')).toHaveLength(2)
  })

  it('lists the Personas that answer by @name, and the sections of Settings and Work', () => {
    const items = jumpItems(sources())
    expect(rows(of(items, 'persona'))).toEqual(['@sage — Persona'])
    const sections = of(items, 'setting')
    expect(sections[0]).toMatchObject({
      label: 'Routines',
      detail: 'Section in Work',
      link: { to: '/work', hash: 'routines' },
    })
    expect(sections.map((item) => item.link)).toContainEqual({ to: '/settings', hash: 'usage' })
  })
})

const item = (label: string, kind: JumpItem['kind'] = 'topic'): JumpItem => ({
  id: `${kind}:${label}`,
  kind,
  label,
  detail: kind,
  link: { to: '/settings' },
})
const ranked = (items: readonly JumpItem[], query: string) =>
  jumpResults(items, query).map((group) => `${group.label}: ${group.items.map(({ label }) => label).join(', ')}`)

describe('how a query ranks the places', () => {
  it('shows the pages and then the Topics before anything is typed', () => {
    expect(ranked(jumpItems(sources()), '  ')).toEqual([
      'Places: Activity, Work, Apps, Connections, Personas, Settings, All threads',
      'Topics: Personal, Travel',
    ])
  })

  it('puts a label that starts with the query before a word that does, and that before one that only contains it', () => {
    const items = [item('Unrelated'), item('Strategy notes'), item('Big trip'), item('Trip planning'), item('Astrip')]
    expect(ranked(items, 'trip')).toEqual(['Topics: Trip planning, Big trip, Astrip'])
  })

  it('ignores case, accents and a leading # or @', () => {
    const items = [item('Café plans'), item('@sage', 'persona')]
    expect(ranked(items, 'CAFE')).toEqual(['Topics: Café plans'])
    expect(ranked(items, '#café')).toEqual(['Topics: Café plans'])
    expect(ranked(items, 'sa')).toEqual(['Personas: @sage'])
    expect(ranked(items, '@sa')).toEqual(['Personas: @sage'])
  })

  it('leads with the group of the best match, equal ones in their kind’s order', () => {
    const items = [item('Mail', 'destination'), item('Gmail', 'app'), item('Mailbox', 'thread'), item('Mail', 'topic')]
    expect(ranked(items, 'mail')).toEqual(['Places: Mail', 'Topics: Mail', 'Threads: Mailbox', 'Apps: Gmail'])
    expect(ranked([item('Gmail', 'destination'), item('Mailbox', 'thread')], 'mail')).toEqual([
      'Threads: Mailbox',
      'Places: Gmail',
    ])
  })

  it('keeps equal matches in their own order and shows at most eight of a kind', () => {
    const items = Array.from({ length: 12 }, (_, index) => item(`Note ${String(index + 1)}`, 'thread'))
    const [threads] = jumpResults(items, 'note')
    expect(threads?.items.map(({ label }) => label)).toEqual(items.slice(0, 8).map(({ label }) => label))
  })

  it('finds nothing for a query nothing matches', () => {
    expect(jumpResults(jumpItems(sources()), 'zzz')).toEqual([])
  })
})
