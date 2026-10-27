import { describe, expect, it } from 'vitest'
import { type ConversationView, EVERYTHING, type TopicView } from '@goblin/contracts'
import {
  PERSONAL,
  channelOf,
  channels,
  isChannel,
  madeByGroups,
  madeByApp,
  matchingTopics,
  reachChange,
  reachNote,
  topicOfChannel,
  topicThreads,
  topicsOf,
} from '../src/lib/topics.ts'

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
const TOPICS = [
  topic(3, 'zebra', '30'),
  topic(1, 'Personal', '1', { personal: true }),
  topic(2, 'Japan', '20'),
  topic(4, 'Taxes', '40', { archivedAt: 9 }),
]

describe('Topics as channels', () => {
  it('is Personal alone on a server without Topics', () => {
    expect(topicsOf([])).toEqual([PERSONAL])
    expect(channels([]).active.map(({ name }) => name)).toEqual(['Personal'])
  })

  it('lists Personal first, then by name whatever the case, and the archived apart', () => {
    const { active, archived } = channels(TOPICS)
    expect(active.map(({ name }) => name)).toEqual(['Personal', 'Japan', 'zebra'])
    expect(archived.map(({ name }) => name)).toEqual(['Taxes'])
  })

  it("finds a channel's Topic", () => {
    expect(topicOfChannel('20', TOPICS)?.name).toBe('Japan')
    expect(topicOfChannel('1', [])).toBe(PERSONAL)
    expect(topicOfChannel('99', TOPICS)).toBeUndefined()
  })
})

describe('the channel a chat belongs to', () => {
  const views = [
    view('1', { kind: 'main', parent: undefined }),
    view('20', { kind: 'main', conversation: true, parent: undefined, topic: 2 }),
    view('5'),
    view('6', { parent: '5' }),
    view('7', { kind: 'subagent', parent: '6' }),
    view('8', { parent: '20', topic: 2 }),
    view('9', { parent: '8' }),
    view('10', { parent: '11' }),
    view('11', { parent: '10' }),
  ]
  it('is the chat itself for a channel', () => {
    expect(isChannel(views[1] ?? view('0'))).toBe(true)
    expect(channelOf('20', views, TOPICS)).toBe('20')
    expect(channelOf('1', views, TOPICS)).toBe('1')
  })

  it('walks up threads and subagents to their channel, or takes their Topic', () => {
    expect(channelOf('7', views, TOPICS)).toBe('1')
    expect(channelOf('9', views, TOPICS)).toBe('20')
    expect(channelOf('8', views, [])).toBe('20')
  })

  it("ends a loop in stored parents at Personal's channel, and an unknown chat there too", () => {
    expect(channelOf('10', views, TOPICS)).toBe('1')
    expect(channelOf('404', views, TOPICS)).toBe('1')
  })
})

describe("a Topic's threads in the sidebar", () => {
  const views = [
    view('1', { kind: 'main', parent: undefined }),
    view('20', { kind: 'main', conversation: true, parent: undefined, topic: 2 }),
    view('5', { lastReplyAt: 50, readAt: 10 }),
    view('6', { parent: '5', lastReplyAt: 60, readAt: 60 }),
    view('7', { kind: 'subagent', parent: '1' }),
    view('8', { parent: '20', topic: 2, lastReplyAt: 80 }),
    view('9', { closedAt: 3, lastReplyAt: 99 }),
    view('10'),
  ]
  it('lists the threads at work, unread or recently opened, newest first, under their own channel', () => {
    const working = { '7': { id: '7', state: 'working' as const, since: 1 } }
    const listed = topicThreads('1', views, TOPICS, working, new Set(['6']))
    expect(listed.map(({ id }) => id)).toEqual(['6', '5', '7'])
    expect(topicThreads('20', views, TOPICS, {}, new Set()).map(({ id }) => id)).toEqual(['8'])
  })

  it('never lists a closed thread, and lists at most five', () => {
    expect(topicThreads('1', views, TOPICS, {}, new Set(['9'])).map(({ id }) => id)).toEqual(['5'])
    const many = [
      views[0] ?? view('1'),
      ...Array.from({ length: 8 }, (_, n) => view(String(30 + n), { lastReplyAt: n + 1 })),
    ]
    expect(topicThreads('1', many, [], {}, new Set()).map(({ id }) => id)).toEqual(['37', '36', '35', '34', '33'])
  })
})

/** A Topic an installed app made, for display (ADR 0115). */
const made = (id: number, name: string, app: string, extra: Partial<TopicView> = {}) =>
  topic(id, name, String(id * 10), { madeBy: { app }, createdBy: 'agent', createdAt: id, ...extra })

describe('the Topics an installed app made, in the sidebar (ADR 0115)', () => {
  const MADE = [
    ...TOPICS,
    made(5, 'deal-5', 'swarmm-prod'),
    made(6, 'deal-6', 'swarmm-prod'),
    made(7, 'Deal-7', 'swarmm-prod', { archivedAt: 99 }),
    made(8, 'quest-8', 'sidequest'),
    made(9, 'quest-9', 'sidequest'),
  ]
  const views = [
    view('50', { kind: 'main', conversation: true, parent: undefined, topic: 5, lastReplyAt: 40 }),
    view('60', { kind: 'main', conversation: true, parent: undefined, topic: 6, lastReplyAt: 30 }),
    view('61', { parent: '60', topic: 6, lastReplyAt: 70 }),
    view('80', { kind: 'main', conversation: true, parent: undefined, topic: 8, lastReplyAt: 50 }),
  ]

  it("keeps the owner's own channels as they were, with none an app made", () => {
    expect(channels(MADE)).toEqual(channels(TOPICS))
    expect(madeByApp(MADE[5] ?? PERSONAL)).toBe('swarmm-prod')
    expect(madeByApp(PERSONAL)).toBeUndefined()
  })

  it('groups the active ones by app, the latest active first, a reply in a thread counting for its Topic', () => {
    const groups = madeByGroups(MADE, views)
    expect(groups.map(({ app, topics, latest }) => ({ app, topics: topics.map(({ name }) => name), latest }))).toEqual([
      { app: 'swarmm-prod', topics: ['deal-6', 'deal-5'], latest: 70 },
      { app: 'sidequest', topics: ['quest-8', 'quest-9'], latest: 50 },
    ])
  })

  it('counts a Topic with no chat yet from when it was made, and has no group when no app made any', () => {
    expect(madeByGroups(MADE, []).map(({ app, topics }) => [app, topics.map(({ id }) => id)])).toEqual([
      ['sidequest', [9, 8]],
      ['swarmm-prod', [6, 5]],
    ])
    expect(madeByGroups(TOPICS, views)).toEqual([])
  })

  it('filters them by name whatever the case, and keeps them all while the filter is blank', () => {
    const topics = madeByGroups(MADE, views)[0]?.topics ?? []
    expect(matchingTopics(topics, ' DEAL-5 ').map(({ id }) => id)).toEqual([5])
    expect(matchingTopics(topics, '  ')).toBe(topics)
    expect(matchingTopics(topics, 'nothing')).toEqual([])
  })
})

describe("a Topic's reach in its channel info (ADR 0115)", () => {
  it('says a sealed Topic sees only itself and a hub every Topic, and asks for exactly the reach the switch chose', () => {
    expect(reachNote({ reach: 'sealed' })).toContain("only this Topic's chats and files")
    expect(reachNote({ reach: 'hub' })).toContain('every Topic')
    expect(reachChange(true)).toEqual({ reach: 'hub' })
    expect(reachChange(false)).toEqual({ reach: 'sealed' })
    expect(PERSONAL.reach).toBe('hub')
  })
})
