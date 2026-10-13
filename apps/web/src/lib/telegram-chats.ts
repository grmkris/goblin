// Telegram chats routed to Topics (ADR 0055): the Chats list's rows nested as Telegram nests them, their words, and the
// route select's options and picks. Pure, so the Chats list and Activity's offer only draw it.
import {
  type NewChatsDefault,
  PERSONAL_TOPIC,
  type PersonaView,
  type RoutePick,
  TELEGRAM_DM,
  type TelegramChat,
  type TopicView,
} from '@goblin/contracts'
import type { Label } from './labels.ts'

/** A chat with its forum topics under it; `row` is absent when goblin knows only the chat's topics. */
export type ChatGroup = {
  readonly chat: string
  readonly title: string
  readonly row: TelegramChat | undefined
  readonly topics: readonly TelegramChat[]
}

/** A chat or topic's key in a list: its handle and thread. */
export const chatKey = (chat: Pick<TelegramChat, 'chat' | 'thread'>): string => `${chat.chat}:${String(chat.thread)}`

/** The rows as the Chats list nests them: the private chat first, then the groups in the server's order, each with its topics. */
export function chatGroups(chats: readonly TelegramChat[]): readonly ChatGroup[] {
  const order = [...new Set(chats.map(({ chat }) => chat))].toSorted(
    (a, b) => Number(b === TELEGRAM_DM) - Number(a === TELEGRAM_DM),
  )
  return order.map((chat) => {
    const row = chats.find((each) => each.chat === chat && each.thread === 0)
    const topics = chats.filter((each) => each.chat === chat && each.thread > 0)
    return { chat, title: row?.title ?? topics[0]?.chatTitle ?? 'A Telegram chat', row, topics }
  })
}

/** What a row is, quietly: the private chat, a group, or a forum topic. */
export function kindWords(chat: Pick<TelegramChat, 'kind' | 'thread'>): string {
  if (chat.thread > 0) return 'Topic'
  return chat.kind === 'private' ? 'Private chat' : 'Group'
}

/** A row's quiet line: its kind, and who set its route when goblin did. */
export const chatMeta = (chat: TelegramChat): string =>
  chat.updatedBy === 'agent' && chat.route !== undefined ? `${kindWords(chat)}, set by goblin` : kindWords(chat)

/** The messages a waiting chat holds, in words; none when it holds none. */
export function waitingWords(held: number): string | undefined {
  if (held <= 0) return undefined
  return held === 1 ? '1 message waiting' : `${String(held)} messages waiting`
}

/** A row's state, only when it is not the usual one: waiting for the owner's choice, paused, or left. */
export function chatStatus(chat: Pick<TelegramChat, 'status' | 'held'>): Label | undefined {
  switch (chat.status) {
    case 'pending':
      return { text: waitingWords(chat.held) ?? 'Waiting for you', tone: 'attention' }
    case 'paused':
      return { text: 'Paused', tone: 'quiet' }
    case 'left':
      return { text: 'Left', tone: 'quiet' }
    case 'routed':
      return undefined
  }
}

/**
 * What the route select holds: `place` is `answer:<topic>` or `listen:<topic>` (with `new` for a new Topic named after
 * the chat), `ignore`, `inherit` (a forum topic following its chat), or empty while nothing is picked; `responder` is
 * `goblin` or `persona:<id>`, and counts only for an answering place.
 */
export type RouteChoice = { readonly place: string; readonly responder: string }

const GOBLIN = 'goblin'

/** The longest name a Topic takes. */
const TOPIC_NAME_MAX = 80

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** `name` cut to what a Topic's name takes, never inside a character. */
function topicName(name: string): string {
  let kept = ''
  for (const { segment } of graphemes.segment(name.trim())) {
    if (kept.length + segment.length > TOPIC_NAME_MAX) break
    kept += segment
  }
  return kept
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const live = <T extends { readonly archivedAt?: number | undefined }>(items: readonly T[]): readonly T[] =>
  items.filter((item) => item.archivedAt === undefined)

/**
 * The name a new Topic for this chat or topic takes: its title, cut to fit. None for the private chat itself (it has
 * #Personal), for a blank title, or when a live Topic has that name already (the select offers that one instead).
 */
export function newTopicName(chat: TelegramChat, topics: readonly TopicView[]): string | undefined {
  if (chat.chat === TELEGRAM_DM && chat.thread === 0) return undefined
  const name = topicName(chat.title)
  if (name === '' || live(topics).some((topic) => sameName(topic.name, name))) return undefined
  return name
}

/** The choice a row shows: its route, its chat's (a forum topic following it), or nothing while it waits. */
export function choiceOf(chat: TelegramChat): RouteChoice {
  const { route } = chat
  if (route === undefined)
    return { place: chat.thread > 0 && chat.inherited !== undefined ? 'inherit' : '', responder: GOBLIN }
  if (route.mode === 'ignore') return { place: 'ignore', responder: GOBLIN }
  if (route.mode === 'listen') return { place: `listen:${String(route.topic)}`, responder: GOBLIN }
  return {
    place: `answer:${String(route.topic)}`,
    responder: route.persona === undefined ? GOBLIN : `persona:${String(route.persona)}`,
  }
}

/**
 * The choice a pick on its way names, so the row shows it while it saves. A new Topic it makes is named by its id once
 * the workspace lists it, before the agent's answer replaces the row.
 */
export function choiceOfPick(pick: RoutePick, topics: readonly TopicView[]): RouteChoice {
  const responder = pick.persona === undefined ? GOBLIN : `persona:${String(pick.persona)}`
  if (pick.mode === 'ignore' || pick.mode === 'inherit') return { place: pick.mode, responder }
  const { newTopic } = pick
  const made = newTopic === undefined ? undefined : live(topics).find((topic) => sameName(topic.name, newTopic))
  const topic = pick.topic ?? made?.id
  return { place: `${pick.mode}:${topic === undefined ? 'new' : String(topic)}`, responder }
}

/**
 * The choice an offer starts with: what the row has already (a forum topic follows its chat), else a new Topic named
 * after the chat, else the live Topic that has its name, else #Personal; goblin answers.
 */
export function suggestedChoice(chat: TelegramChat, topics: readonly TopicView[]): RouteChoice {
  const current = choiceOf(chat)
  if (current.place !== '') return current
  if (newTopicName(chat, topics) !== undefined) return { place: 'answer:new', responder: GOBLIN }
  const named = live(topics).find((topic) => sameName(topic.name, topicName(chat.title)))
  return { place: `answer:${String(named?.id ?? PERSONAL_TOPIC)}`, responder: GOBLIN }
}

/** The pick a choice makes for the owner API; none while nothing is picked, or for a place the select does not offer. */
export function pickOf(chat: TelegramChat, choice: RouteChoice, topics: readonly TopicView[]): RoutePick | undefined {
  const base = { chat: chat.chat, thread: chat.thread }
  const { place } = choice
  if (place === 'ignore') return { ...base, mode: 'ignore' }
  if (place === 'inherit') return chat.thread > 0 ? { ...base, mode: 'inherit' } : undefined
  const [mode, where] = place.split(':')
  if (mode !== 'answer' && mode !== 'listen') return undefined
  const persona = Number(choice.responder.split(':')[1])
  const answeredBy =
    mode === 'answer' && choice.responder.startsWith('persona:') && Number.isInteger(persona) && persona > 0
      ? { persona }
      : {}
  if (where === 'new') {
    const name = newTopicName(chat, topics)
    return name === undefined ? undefined : { ...base, mode, newTopic: name, ...answeredBy }
  }
  const topic = Number(where)
  return Number.isInteger(topic) && topic > 0 ? { ...base, mode, topic, ...answeredBy } : undefined
}

/** One option of a select. */
export type Option = { readonly value: string; readonly text: string }

/** A run of options, under a label when it has one. */
export type OptionGroup = { readonly label?: string; readonly options: readonly Option[] }

/** A Topic as an option names it: by name, archived ones said so, one goblin does not list (just made) plainly. */
function topicWords(id: number, topics: readonly TopicView[]): string {
  const topic = topics.find((each) => each.id === id)
  if (topic === undefined) return 'a new Topic'
  return topic.archivedAt === undefined ? `#${topic.name}` : `#${topic.name} (archived)`
}

/**
 * The route select's options for a row: Same as the chat (a forum topic), then answering in each live Topic or a new
 * one named after the chat, listening only in the same, then Ignore. The Topic the row's choice names is offered even
 * when it is not live, so the select always shows what is chosen.
 */
export function routeOptions(
  chat: TelegramChat,
  topics: readonly TopicView[],
  current: string,
): readonly OptionGroup[] {
  const shown = live(topics).map((topic) => topic.id)
  const [mode, where] = current.split(':')
  const held = Number(where)
  const ids =
    (mode === 'answer' || mode === 'listen') && Number.isInteger(held) && held > 0 && !shown.includes(held)
      ? [...shown, held]
      : shown
  const name = newTopicName(chat, topics)
  const places = (kind: 'answer' | 'listen', suffix: string): readonly Option[] => [
    ...ids.map((id) => ({ value: `${kind}:${String(id)}`, text: `${topicWords(id, topics)}${suffix}` })),
    ...(name === undefined ? [] : [{ value: `${kind}:new`, text: `New topic #${name}${suffix}` }]),
  ]
  return [
    ...(chat.thread > 0 ? [{ options: [{ value: 'inherit', text: 'Same as the chat' }] }] : []),
    { label: 'Answer', options: places('answer', '') },
    { label: 'Listen only', options: places('listen', ', listen only') },
    { options: [{ value: 'ignore', text: 'Ignore' }] },
  ]
}

/** Who answers in an answering route: goblin, or a live Persona; the one chosen is offered even when archived. */
export function responderOptions(personas: readonly PersonaView[], current: string): readonly Option[] {
  const id = Number(current.split(':')[1])
  const chosen = personas.find((persona) => persona.id === id)
  const offered = chosen?.archivedAt === undefined ? live(personas) : [...live(personas), chosen]
  return [
    { value: GOBLIN, text: 'goblin answers' },
    ...offered.map((persona) => ({
      value: `persona:${String(persona.id)}`,
      text: `@${persona.name}${persona.archivedAt === undefined ? '' : ' (archived)'} answers`,
    })),
  ]
}

/** Whether a choice answers back, so it names who does. */
export const answers = (choice: RouteChoice): boolean => choice.place.startsWith('answer:')

/** The default for chats goblin has not seen, as the "New chats" select offers it, with what each does. */
export const NEW_CHATS: Readonly<Record<NewChatsDefault, { readonly text: string; readonly about: string }>> = {
  ask: {
    text: 'Ask me',
    about: 'goblin asks you in your private chat and in Activity. Its messages wait until you choose.',
  },
  topic: { text: 'New topic', about: 'Each new chat gets a Topic of its own, and goblin answers there.' },
  personal: { text: 'Personal', about: 'New chats go to #Personal, and goblin answers there.' },
}

/** A "New chats" select value as the default it names; none for one it does not. */
export const newChatsOf = (value: string): NewChatsDefault | undefined =>
  value === 'ask' || value === 'topic' || value === 'personal' ? value : undefined

/** Where the owner lets goblin see their groups (mysi's consent screen): an https link only, without credentials. */
export function widenLink(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined
  const parsed = new URL(url)
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' ? parsed.href : undefined
}

/** What Activity offers to route: chats waiting for the owner, and topics goblin asked about, never a paused or left one. */
export const offersOf = (chats: readonly TelegramChat[]): readonly TelegramChat[] =>
  chats.filter((chat) => chat.status === 'pending' || (chat.offer && chat.status === 'routed'))

/** An offer's title, before the chat's own name: a new chat, or a new topic and the chat it is in. */
export const offerWords = (chat: TelegramChat): string => (chat.thread > 0 ? 'New Telegram topic' : 'New Telegram chat')
