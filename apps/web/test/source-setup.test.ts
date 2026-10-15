import { describe, expect, it } from 'vitest'
import { EVERYTHING, type SourceSetup, type SourceView, type TopicView } from '@goblin/contracts'
import {
  choiceOfRoute,
  conversationName,
  keyWords,
  newKeysWords,
  routeOfChoice,
  routeWords,
  sourceRouteOptions,
  sourceStatus,
  sourcesToReview,
  waitingConversations,
} from '../src/lib/source-routes.ts'
import { setupFacts, sinkArguments, sinkFromSource, sinkPolicy } from '../src/lib/source-setup.ts'

const topic = (id: number, name: string, archivedAt?: number): TopicView => ({
  id,
  name,
  conversation: String(id * 10),
  ...(id === 1 && { personal: true }),
  ...(archivedAt !== undefined && { archivedAt }),
  searchExcluded: false,
  revision: 0,
  setup: EVERYTHING,
  createdBy: 'owner',
  createdAt: 1,
})
const TOPICS = [topic(1, 'Personal'), topic(2, 'Travel'), topic(3, 'Old', 5)]

/** An inbox-style setup: a message event, keyed by chat, the owner's when `/from/isOwner` is true, answered back. */
const SETUP: SourceSetup = {
  wake: { event: 'message.received', arguments: {} },
  key: [{ name: 'chat', pointer: '/chat' }],
  speaksForMe: { pointer: '/from/isOwner', equals: true },
  others: 'notice',
  read: { from: 'payload', text: '/text' },
  reply: {
    tool: 'message_send',
    arguments: { chat: '{{key.chat}}', text: '{{text}}', operationId: '{{operationId}}' },
    maxChars: 3500,
  },
  newKeys: { to: 'held' },
}

const source = (fields: Partial<SourceView> = {}): SourceView => ({
  id: 'src_0123456789abcdef',
  connectionId: 'chat',
  label: 'Chat',
  title: 'Messages from Chat',
  setup: SETUP,
  revision: 1,
  state: 'active',
  proposedBy: 'owner',
  waiting: [],
  createdAt: 1,
  updatedAt: 1,
  ...fields,
})

describe('a Source in words (ADR 0066)', () => {
  it('names a conversation by its key parts, leaving out empty ones', () => {
    expect(keyWords({ chat: 'dm', thread: 3 })).toBe('chat dm · thread 3')
    expect(keyWords({ chat: 'dm', thread: null })).toBe('chat dm')
    expect(keyWords({})).toBe('A conversation')
    expect(conversationName({ values: { chat: 'c1' }, title: 'Trip planning' })).toBe('Trip planning')
    expect(conversationName({ values: { chat: 'c1' } })).toBe('chat c1')
  })

  it('says each fact of a setup, with every pointer and tool as it is', () => {
    const facts = setupFacts(SETUP, { event: 'Message received', newKeys: (newKeys) => newKeys.to })
    expect(facts.map((fact) => fact.term)).toEqual([
      'Wakes on',
      'Conversations',
      'You speak',
      'Others',
      'Reads',
      'Answers',
      'New conversations',
    ])
    expect(facts[2]?.text).toBe('When /from/isOwner is true: those become your own turns')
    expect(facts[5]?.text).toBe('Sent back with message_send, in pieces of at most 3,500 characters')
    expect(facts[6]?.text).toBe('held')
  })

  it("names a setup's title and attachments pointers, and a new Topic for each new conversation", () => {
    const setup: SourceSetup = {
      ...SETUP,
      read: { from: 'payload', text: '/text', title: '/chatTitle', attachments: '/attachments' },
      newKeys: { to: 'topic-per-key' },
    }
    const facts = setupFacts(setup, {
      event: 'Message received',
      newKeys: (newKeys) => newKeysWords(newKeys, TOPICS, []),
    })
    expect(facts[4]?.text).toBe(
      "From the event's data: the event is one message, its words at /text, its conversation's name at /chatTitle, what it brought at /attachments, kept in your files",
    )
    expect(facts[6]?.text).toBe('Each in a new Topic of its own, named after it, answered by goblin')
    expect(newKeysWords({ to: 'listen', topic: 2 }, TOPICS, [])).toBe('Kept as notes in #Travel')
  })

  it('says where each route sends a conversation', () => {
    const personas = [
      {
        id: 7,
        name: 'Guide',
        avatar: { glyph: 'G', hue: 1 },
        role: '',
        instructions: '',
        setup: { mcpServers: [], skills: [], apps: [] },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    expect(routeWords({ to: 'persona', persona: 7, topic: 2 }, TOPICS, personas)).toBe(
      'Turns in #Travel, answered by @Guide',
    )
    expect(routeWords({ to: 'listen', topic: 9 }, TOPICS, personas)).toBe('Kept as notes in #Personal')
  })

  it('says where a Source stands', () => {
    expect(sourceStatus({ state: 'paused', paused: 'review' }).text).toBe('Needs your review')
    expect(sourceStatus({ state: 'paused', paused: 'owner' }).tone).toBe('quiet')
    expect(sourceStatus({ state: 'proposed' }).tone).toBe('attention')
  })
})

describe("a Source's route select", () => {
  it('turns every route into a choice and back', () => {
    for (const route of [
      { to: 'topic', topic: 2 },
      { to: 'persona', persona: 7, topic: 2 },
      { to: 'listen', topic: 1 },
      { to: 'ignore' },
      { to: 'held' },
    ] as const)
      expect(routeOfChoice(choiceOfRoute(route))).toEqual(route)
    expect(routeOfChoice({ place: 'answer:0', responder: 'goblin' })).toBeUndefined()
    expect(routeOfChoice({ place: '', responder: 'goblin' })).toBeUndefined()
  })

  it('offers the live Topics to answer or keep notes in, and the chosen one even when archived', () => {
    const groups = sourceRouteOptions(TOPICS, 'listen:3')
    expect(groups.map((group) => group.options.map((option) => option.value))).toEqual([
      ['answer:1', 'answer:2', 'answer:3'],
      ['listen:1', 'listen:2', 'listen:3'],
      ['held', 'ignore'],
    ])
    expect(groups[1]?.options[2]?.text).toBe('#Old (archived), as notes')
  })
})

describe('what Activity offers from Sources', () => {
  it('lists the conversations an active Source holds and the Sources paused for review', () => {
    const waiting = { key: '["g1"]', values: { chat: 'g1' }, held: 2 }
    const sources = [
      source({ id: 'src_00000000000000aa', waiting: [waiting] }),
      source({ id: 'src_00000000000000bb', state: 'paused', paused: 'review', waiting: [waiting] }),
      source({ id: 'src_00000000000000cc', state: 'paused', paused: 'owner' }),
    ]
    expect(waitingConversations(sources).map((item) => item.source.id)).toEqual(['src_00000000000000aa'])
    expect(sourcesToReview(sources).map((each) => each.id)).toEqual(['src_00000000000000bb'])
  })
})

/** The placeholders a notice's arguments may use. */
const notice = (name: string) => name === 'text' || name === 'operationId'

describe('Notify me via', () => {
  it('keeps delivery rules and the exact echo selector through the settings JSON', () => {
    const policy = {
      result: { accepted: { pointer: '/status', equals: 'sent' }, retryAt: '/retryAt' },
      echo: { event: 'chat.message', arguments: { chat: 'dm' } },
    }
    expect(sinkPolicy(JSON.stringify(policy))).toEqual(policy)
    expect(sinkPolicy('invalid')).toBeUndefined()
    expect(sinkPolicy('{"result": {"accepted": {"pointer": "not/a/pointer", "equals": true}}}')).toBeUndefined()
  })
  it("copies a Source's reply with one conversation's key filled in, keeping the notice's own placeholders", () => {
    expect(sinkFromSource(source(), { chat: 'dm' })).toEqual({
      connectionId: 'chat',
      tool: 'message_send',
      arguments: { chat: 'dm', text: '{{text}}', operationId: '{{operationId}}' },
      echo: SETUP.wake,
    })
    const { reply: _reply, ...silent } = SETUP
    expect(sinkFromSource(source({ setup: silent }), { chat: 'dm' })).toBeUndefined()
  })

  it('reads the arguments the owner wrote, refusing what is not a whole-leaf template with the words', () => {
    expect(sinkArguments('{"chat":"dm","text":"{{text}}"}', notice)).toEqual({
      template: { chat: 'dm', text: '{{text}}' },
    })
    expect(sinkArguments('{"text":"Hi {{text}}"}', notice)).toHaveProperty('problem')
    expect(sinkArguments('{"chat":"dm"}', notice)).toHaveProperty('problem')
    expect(sinkArguments('{"text":"{{key.chat}}"}', notice)).toHaveProperty('problem')
    expect(sinkArguments('[1]', notice)).toEqual({ problem: 'The arguments must be a JSON object.' })
    expect(sinkArguments('{', notice)).toEqual({ problem: 'The arguments are not JSON.' })
  })
})
