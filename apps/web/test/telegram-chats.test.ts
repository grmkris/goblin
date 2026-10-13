import { describe, expect, it } from 'vitest'
import { EVERYTHING, type PersonaView, type TelegramChat, type TopicView } from '@goblin/contracts'
import {
  chatGroups,
  chatMeta,
  chatStatus,
  choiceOf,
  choiceOfPick,
  kindWords,
  newChatsOf,
  newTopicName,
  offersOf,
  offerWords,
  pickOf,
  responderOptions,
  routeOptions,
  suggestedChoice,
  waitingWords,
  widenLink,
} from '../src/lib/telegram-chats.ts'

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

const TOPICS = [topic(1, 'Personal'), topic(2, 'Travel'), topic(3, 'Old trips', 5)]
const PERSONAS = [persona(7, 'Guide'), persona(8, 'Retired', 5)]

const chat = (fields: Partial<TelegramChat> & Pick<TelegramChat, 'chat' | 'title'>): TelegramChat => ({
  thread: 0,
  kind: 'supergroup',
  status: 'routed',
  held: 0,
  offer: false,
  listed: true,
  revision: 0,
  ...fields,
})

const DM = chat({ chat: 'dm', title: 'Kris', kind: 'private', route: { mode: 'answer', topic: 1 } })
const TRIP = chat({ chat: 'g_trip', title: 'Trip planning', status: 'pending', held: 3, offer: true, isForum: true })
const PACKING = chat({ chat: 'g_trip', thread: 5, title: 'Packing', chatTitle: 'Trip planning', status: 'pending' })
const IDEAS = chat({
  chat: 'dm',
  thread: 12,
  title: 'Ideas',
  chatTitle: 'Kris',
  kind: 'private',
  inherited: { mode: 'answer', topic: 1 },
})

describe('Telegram chats', () => {
  it('nests each chat’s topics under it, the private chat first and the rest in the server’s order', () => {
    const lone = chat({ chat: 'g_lone', thread: 9, title: 'Notes', chatTitle: 'Study group' })
    const groups = chatGroups([TRIP, PACKING, lone, DM, IDEAS])
    expect(
      groups.map((group) => [group.chat, group.title, group.row?.title, group.topics.map((each) => each.title)]),
    ).toEqual([
      ['dm', 'Kris', 'Kris', ['Ideas']],
      ['g_trip', 'Trip planning', 'Trip planning', ['Packing']],
      ['g_lone', 'Study group', undefined, ['Notes']],
    ])
  })

  it('says what a row is and its state only when it is not the usual one', () => {
    expect(kindWords(DM)).toBe('Private chat')
    expect(kindWords(TRIP)).toBe('Group')
    expect(kindWords(chat({ chat: 'g_small', title: 'Small', kind: 'group' }))).toBe('Group')
    expect(kindWords(IDEAS)).toBe('Topic')
    expect(chatStatus(DM)).toBeUndefined()
    expect(chatStatus(TRIP)).toEqual({ text: '3 messages waiting', tone: 'attention' })
    expect(chatStatus(PACKING)).toEqual({ text: 'Waiting for you', tone: 'attention' })
    expect(chatStatus({ status: 'paused', held: 0 })).toEqual({ text: 'Paused', tone: 'quiet' })
    expect(chatStatus({ status: 'left', held: 0 })).toEqual({ text: 'Left', tone: 'quiet' })
    expect(waitingWords(1)).toBe('1 message waiting')
    expect(waitingWords(0)).toBeUndefined()
    expect(chatMeta({ ...TRIP, route: { mode: 'ignore' }, updatedBy: 'agent' })).toBe('Group, set by goblin')
    expect(chatMeta({ ...DM, updatedBy: 'owner' })).toBe('Private chat')
  })

  it('names a new Topic after the chat, never for the private chat itself or a name a live Topic has', () => {
    expect(newTopicName(TRIP, TOPICS)).toBe('Trip planning')
    expect(newTopicName(DM, TOPICS)).toBeUndefined()
    expect(newTopicName(IDEAS, TOPICS)).toBe('Ideas')
    expect(newTopicName({ ...TRIP, title: 'travel' }, TOPICS)).toBeUndefined()
    // An archived Topic frees its name.
    expect(newTopicName({ ...TRIP, title: 'Old trips' }, TOPICS)).toBe('Old trips')
    expect(newTopicName({ ...TRIP, title: '   ' }, TOPICS)).toBeUndefined()
    expect(newTopicName({ ...TRIP, title: `${'é'.repeat(79)}🧳` }, TOPICS)).toBe('é'.repeat(79))
  })

  it('offers answering and listening in each live Topic or a new one, Ignore, and Same as the chat for a topic', () => {
    expect(routeOptions(TRIP, TOPICS, '')).toEqual([
      {
        label: 'Answer',
        options: [
          { value: 'answer:1', text: '#Personal' },
          { value: 'answer:2', text: '#Travel' },
          { value: 'answer:new', text: 'New topic #Trip planning' },
        ],
      },
      {
        label: 'Listen only',
        options: [
          { value: 'listen:1', text: '#Personal, listen only' },
          { value: 'listen:2', text: '#Travel, listen only' },
          { value: 'listen:new', text: 'New topic #Trip planning, listen only' },
        ],
      },
      { options: [{ value: 'ignore', text: 'Ignore' }] },
    ])
    expect(routeOptions(IDEAS, TOPICS, 'inherit')[0]).toEqual({
      options: [{ value: 'inherit', text: 'Same as the chat' }],
    })
    // The chosen Topic shows even when archived, or not listed yet.
    const archived = routeOptions(DM, TOPICS, 'listen:3')
    expect(archived[1]?.options.at(-1)).toEqual({ value: 'listen:3', text: '#Old trips (archived), listen only' })
    expect(routeOptions(DM, TOPICS, 'answer:9')[0]?.options.at(-1)).toEqual({ value: 'answer:9', text: 'a new Topic' })
  })

  it('offers goblin or a live Persona to answer, and the chosen one when archived', () => {
    expect(responderOptions(PERSONAS, 'goblin')).toEqual([
      { value: 'goblin', text: 'goblin answers' },
      { value: 'persona:7', text: '@Guide answers' },
    ])
    expect(responderOptions(PERSONAS, 'persona:8').at(-1)).toEqual({
      value: 'persona:8',
      text: '@Retired (archived) answers',
    })
  })

  it('shows a row’s route, its chat’s for a topic that follows it, and nothing while it waits', () => {
    expect(choiceOf(DM)).toEqual({ place: 'answer:1', responder: 'goblin' })
    expect(choiceOf({ ...TRIP, route: { mode: 'answer', topic: 2, persona: 7 } })).toEqual({
      place: 'answer:2',
      responder: 'persona:7',
    })
    expect(choiceOf({ ...TRIP, route: { mode: 'listen', topic: 2 } }).place).toBe('listen:2')
    expect(choiceOf({ ...TRIP, route: { mode: 'ignore' } }).place).toBe('ignore')
    expect(choiceOf(IDEAS).place).toBe('inherit')
    expect(choiceOf(TRIP).place).toBe('')
  })

  it('makes the owner API’s pick from a choice, and none from one it cannot send', () => {
    expect(pickOf(TRIP, { place: 'answer:new', responder: 'persona:7' }, TOPICS)).toEqual({
      chat: 'g_trip',
      thread: 0,
      mode: 'answer',
      newTopic: 'Trip planning',
      persona: 7,
    })
    expect(pickOf(TRIP, { place: 'listen:2', responder: 'persona:7' }, TOPICS)).toEqual({
      chat: 'g_trip',
      thread: 0,
      mode: 'listen',
      topic: 2,
    })
    expect(pickOf(TRIP, { place: 'ignore', responder: 'goblin' }, TOPICS)).toEqual({
      chat: 'g_trip',
      thread: 0,
      mode: 'ignore',
    })
    expect(pickOf(PACKING, { place: 'inherit', responder: 'goblin' }, TOPICS)).toEqual({
      chat: 'g_trip',
      thread: 5,
      mode: 'inherit',
    })
    expect(pickOf(TRIP, { place: 'inherit', responder: 'goblin' }, TOPICS)).toBeUndefined()
    expect(pickOf(TRIP, { place: '', responder: 'goblin' }, TOPICS)).toBeUndefined()
    expect(pickOf(DM, { place: 'answer:new', responder: 'goblin' }, TOPICS)).toBeUndefined()
    expect(pickOf(TRIP, { place: 'answer:x', responder: 'goblin' }, TOPICS)).toBeUndefined()
  })

  it('shows a pick on its way, a new Topic by its id once the workspace lists it', () => {
    const pick = { chat: 'g_trip', thread: 0, mode: 'answer', newTopic: 'Trip planning', persona: 7 } as const
    expect(choiceOfPick(pick, TOPICS)).toEqual({ place: 'answer:new', responder: 'persona:7' })
    expect(choiceOfPick(pick, [...TOPICS, topic(4, 'Trip Planning')])).toEqual({
      place: 'answer:4',
      responder: 'persona:7',
    })
    expect(choiceOfPick({ chat: 'g_trip', mode: 'ignore' }, TOPICS)).toEqual({ place: 'ignore', responder: 'goblin' })
  })

  it('starts an offer at a new Topic named after the chat, the Topic with its name, or what it follows', () => {
    expect(suggestedChoice(TRIP, TOPICS)).toEqual({ place: 'answer:new', responder: 'goblin' })
    expect(suggestedChoice({ ...TRIP, title: 'Travel' }, TOPICS)).toEqual({ place: 'answer:2', responder: 'goblin' })
    expect(suggestedChoice({ ...TRIP, title: ' ' }, TOPICS).place).toBe('answer:1')
    expect(suggestedChoice({ ...IDEAS, offer: true }, TOPICS).place).toBe('inherit')
  })

  it('offers the waiting chats and the topics goblin asked about, never a paused or left one', () => {
    const paused = chat({ chat: 'g_family', title: 'Family', status: 'paused', offer: true })
    const asked = { ...IDEAS, offer: true }
    expect(offersOf([DM, TRIP, PACKING, paused, asked, IDEAS])).toEqual([TRIP, PACKING, asked])
    expect(offerWords(TRIP)).toBe('New Telegram chat')
    expect(offerWords(PACKING)).toBe('New Telegram topic')
  })

  it('reads the New chats select and keeps the widen link to https', () => {
    expect(newChatsOf('topic')).toBe('topic')
    expect(newChatsOf('all')).toBeUndefined()
    expect(widenLink('https://dev.mysi.lol/consent?grant=1')).toBe('https://dev.mysi.lol/consent?grant=1')
    expect(widenLink('javascript:alert(1)')).toBeUndefined()
    expect(widenLink('https://user:pw@mysi.lol/')).toBeUndefined()
    expect(widenLink(undefined)).toBeUndefined()
  })
})
