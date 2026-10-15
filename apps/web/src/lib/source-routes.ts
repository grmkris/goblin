// Where a Source's conversations go (ADR 0066): a conversation key in words, a route in words, the route select's
// choices and options, where a Source stands, and what Activity offers. Pure, so the route table and Activity only draw
// it. The select's choice is the Telegram chats' (`place`, `responder`), so both lists read alike.
import {
  PERSONAL_TOPIC,
  type PersonaView,
  type SourceKeyValues,
  type SourceRoute,
  type SourceView,
  type SourceWaiting,
  type TopicView,
} from '@goblin/contracts'
import type { Label } from './labels.ts'
import {
  GOBLIN,
  type OptionGroup,
  type RouteChoice,
  offeredTopics,
  responderPersona,
  topicWords,
} from './telegram-chats.ts'

/** A conversation key in words, its parts in order: "chat dm · thread 3"; parts with no value are left out. */
export function keyWords(values: SourceKeyValues): string {
  const parts = Object.entries(values)
    .filter(([, value]) => value !== null && value !== '')
    .map(([name, value]) => `${name} ${String(value)}`)
  return parts.length === 0 ? 'A conversation' : parts.join(' · ')
}

/** A Topic by name for a sentence: `#Name`, `#Personal` for one goblin does not list. */
const topicName = (id: number, topics: readonly TopicView[]): string =>
  `#${topics.find((topic) => topic.id === id)?.name ?? 'Personal'}`

/** Where a route sends a conversation's messages, in words. */
export function routeWords(route: SourceRoute, topics: readonly TopicView[], personas: readonly PersonaView[]): string {
  switch (route.to) {
    case 'topic':
      return `Turns in ${topicName(route.topic, topics)}, answered by goblin`
    case 'persona': {
      const persona = personas.find((each) => each.id === route.persona)?.name ?? 'a Persona'
      return `Turns in ${topicName(route.topic, topics)}, answered by @${persona}`
    }
    case 'listen':
      return `Kept as notes in ${topicName(route.topic, topics)}`
    case 'ignore':
      return 'Ignored'
    case 'held':
      return 'Held until you choose where they go'
  }
}

/** The select's choice for a route: `answer:<topic>` (with who answers), `listen:<topic>`, `ignore` or `held`. */
export function choiceOfRoute(route: SourceRoute): RouteChoice {
  switch (route.to) {
    case 'topic':
      return { place: `answer:${String(route.topic)}`, responder: GOBLIN }
    case 'persona':
      return { place: `answer:${String(route.topic)}`, responder: `persona:${String(route.persona)}` }
    case 'listen':
      return { place: `listen:${String(route.topic)}`, responder: GOBLIN }
    case 'ignore':
    case 'held':
      return { place: route.to, responder: GOBLIN }
  }
}

/** The route a choice names for the owner API; none for a place the select does not offer. */
export function routeOfChoice(choice: RouteChoice): SourceRoute | undefined {
  if (choice.place === 'ignore' || choice.place === 'held') return { to: choice.place }
  const [mode, where] = choice.place.split(':')
  const topic = Number(where)
  if (!Number.isInteger(topic) || topic <= 0) return undefined
  if (mode === 'listen') return { to: 'listen', topic }
  if (mode !== 'answer') return undefined
  const persona = responderPersona(choice.responder)
  return persona === undefined ? { to: 'topic', topic } : { to: 'persona', persona, topic }
}

/** What a waiting conversation's select starts with in Activity: answered by goblin in #Personal. */
export const waitingChoice: RouteChoice = { place: `answer:${String(PERSONAL_TOPIC)}`, responder: GOBLIN }

/**
 * The route select's options: answering in each live Topic, keeping notes in the same, then Hold and Ignore. The Topic
 * the current choice names is offered even when it is not live, so the select always shows what is chosen.
 */
export function sourceRouteOptions(topics: readonly TopicView[], current: string): readonly OptionGroup[] {
  const ids = offeredTopics(topics, current)
  return [
    { label: 'Answer', options: ids.map((id) => ({ value: `answer:${String(id)}`, text: topicWords(id, topics) })) },
    {
      label: 'Keep as notes',
      options: ids.map((id) => ({ value: `listen:${String(id)}`, text: `${topicWords(id, topics)}, as notes` })),
    },
    {
      options: [
        { value: 'held', text: 'Hold for me' },
        { value: 'ignore', text: 'Ignore' },
      ],
    },
  ]
}

/** Where a Source stands, in the owner's words. */
export function sourceStatus(source: Pick<SourceView, 'state' | 'paused'>): Label {
  switch (source.state) {
    case 'proposed':
      return { text: 'Waiting for your review', tone: 'attention' }
    case 'active':
      return { text: 'On', tone: 'good' }
    case 'paused':
      return source.paused === 'review'
        ? { text: 'Needs your review', tone: 'attention' }
        : { text: 'Paused', tone: 'quiet' }
    case 'refused':
      return { text: 'Refused', tone: 'quiet' }
  }
}

/** One conversation waiting for a route, with its Source. */
export type WaitingConversation = { readonly source: SourceView; readonly waiting: SourceWaiting }

/** A waiting conversation's key in a list: its Source and its key. */
export const waitingKey = ({ source, waiting }: WaitingConversation): string => `${source.id}:${waiting.key}`

/** Every conversation waiting for a route, of the Sources that are on, oldest Source first. */
export const waitingConversations = (sources: readonly SourceView[]): readonly WaitingConversation[] =>
  sources
    .filter((source) => source.state === 'active')
    .toReversed()
    .flatMap((source) => source.waiting.map((waiting) => ({ source, waiting })))

/** The Sources paused for the owner's review: their endpoint or grants changed, or their subscription ended. */
export const sourcesToReview = (sources: readonly SourceView[]): readonly SourceView[] =>
  sources.filter((source) => source.state === 'paused' && source.paused === 'review')
