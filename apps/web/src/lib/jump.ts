// The quick switcher's places (Jump to, ⌘K): what the owner can jump to from what the browser already holds, and how a
// query ranks them. Nothing here reads a transcript or asks the server; opening a place changes nothing. Pure.
import type { AgentAppSummary, ConversationView, PersonaView, ServerView, TopicView } from '@goblin/contracts'
import { appOrigin } from './app-names.ts'
import { connectedApps } from './launcher.ts'
import { activePersonas } from './personas.ts'
import type { ShownPin } from './pins.ts'
import { threadList } from './rail.ts'
import { threadTitle } from './threads.ts'
import { channelOf, channels, topicOfChannel } from './topics.ts'

/** A page the switcher opens as a whole. */
type PagePath = '/activity' | '/work' | '/apps' | '/connections' | '/personas' | '/settings' | '/threads'

/** Where a place opens, as the router's `Link` and `navigate` take it. */
export type JumpLink =
  | { readonly to: PagePath; readonly hash?: string }
  | {
      readonly to: '/c/$chatId'
      readonly params: { readonly chatId: string }
      readonly search?: { readonly thread: number }
    }
  | { readonly to: '/a/$appId'; readonly params: { readonly appId: string } }
  | { readonly to: '/apps/$name'; readonly params: { readonly name: string } }
  | { readonly to: '/connections/$connectionId/app'; readonly params: { readonly connectionId: string } }
  | { readonly to: '/p/$id'; readonly params: { readonly id: string } }

/** What a place is, which also orders the switcher's groups. */
export type JumpKind = 'destination' | 'topic' | 'thread' | 'app' | 'persona' | 'setting'

/**
 * One place to jump to: its name, its kind and place in words ("Thread in #Travel"), where it opens, and for an App the
 * origin its tile is coloured by.
 */
export type JumpItem = {
  readonly id: string
  readonly kind: JumpKind
  readonly label: string
  readonly detail: string
  readonly link: JumpLink
  readonly tile?: string
}

/** One group of results under its heading. */
export type JumpGroup = { readonly kind: JumpKind; readonly label: string; readonly items: readonly JumpItem[] }

const GROUPS: readonly { readonly kind: JumpKind; readonly label: string }[] = [
  { kind: 'destination', label: 'Places' },
  { kind: 'topic', label: 'Topics' },
  { kind: 'thread', label: 'Threads' },
  { kind: 'app', label: 'Apps' },
  { kind: 'persona', label: 'Personas' },
  { kind: 'setting', label: 'Sections' },
]

/** How many rows a group shows. */
const SHOWN = 8

/** What the switcher lists from: the workspace feed's slices and the reads the browser already made. */
export type JumpSources = {
  readonly topics: readonly TopicView[]
  readonly views: readonly ConversationView[]
  readonly personas: readonly PersonaView[]
  readonly pins: readonly ShownPin[]
  /** The owner's servers; undefined while they are not read. */
  readonly servers: readonly ServerView[] | undefined
  /** The apps the owner's agent built; undefined while they are not read. */
  readonly built: readonly AgentAppSummary[] | undefined
  /** Whether this deployment has agent apps (ADR 0064): without them there is no Apps page and nothing built. */
  readonly agentApps: boolean
}

const page = (to: PagePath, label: string): JumpItem => ({
  id: `page:${to}`,
  kind: 'destination',
  label,
  detail: 'Page',
  link: { to },
})

/** The sections of Settings and Work a link can open at, by their anchors. */
const SECTIONS: readonly { readonly to: PagePath; readonly hash: string; readonly label: string }[] = [
  { to: '/work', hash: 'routines', label: 'Routines' },
  { to: '/settings', hash: 'usage', label: 'Usage and model' },
  { to: '/settings', hash: 'agent', label: 'Your agent' },
  { to: '/settings', hash: 'clients', label: 'Apps that use your agent' },
  { to: '/settings', hash: 'account', label: 'Account' },
]

/** A server's name as the owner sees it. */
const serverName = (server: ServerView): string => server.title ?? server.label

/** Where a pinned App comes from, in words: a server's own App is pinned; a view names its server or "Built for you". */
function pinPlace(pin: ShownPin, servers: readonly ServerView[] | undefined): string {
  if (pin.kind === 'server' || pin.app === undefined) return 'Pinned'
  const { source } = pin.app
  if (source.kind === 'agent') return 'Built for you'
  const server = servers?.find((each) => each.connectionId === source.connectionId)
  return server === undefined ? source.connectionId : serverName(server)
}

/** A pin's link: a server opens its own App, a view its page. */
const pinLink = (pin: ShownPin): JumpLink =>
  pin.kind === 'server'
    ? { to: '/connections/$connectionId/app', params: { connectionId: pin.connectionId } }
    : { to: '/a/$appId', params: { appId: pin.appId } }

type AppRow = Pick<JumpItem, 'label' | 'detail' | 'link' | 'tile'>

/**
 * The Apps: the owner's pins in their order (those that open now or offer their way back), then the connected
 * services' own Apps, then the built ones (its page when it has no view); each place once.
 */
function apps({ pins, servers, built, agentApps }: JumpSources): JumpItem[] {
  const pinned = pins
    .filter((pin) => pin.state !== 'gone' && pin.state !== 'no-app')
    .map((pin): AppRow => ({
      label: pin.title,
      detail: `App · ${pinPlace(pin, servers)}`,
      link: pinLink(pin),
      tile: pin.kind === 'server' ? pin.connectionId : pin.app === undefined ? pin.appId : appOrigin(pin.app),
    }))
  const connected = connectedApps(servers ?? [])
    .filter((app) => app.connected)
    .map(({ connectionId, title }): AppRow => ({
      label: title,
      detail: 'App · Connected',
      link: { to: '/connections/$connectionId/app', params: { connectionId } },
      tile: connectionId,
    }))
  const made = (agentApps ? (built ?? []) : []).map((app): AppRow => ({
    label: app.title,
    detail: 'App · Built for you',
    link:
      app.app === null
        ? { to: '/apps/$name', params: { name: app.name } }
        : { to: '/a/$appId', params: { appId: app.app } },
    tile: app.name,
  }))
  const seen = new Set<string>()
  return [...pinned, ...connected, ...made].flatMap((app): JumpItem[] => {
    const id = `app:${JSON.stringify(app.link)}`
    if (seen.has(id)) return []
    seen.add(id)
    return [{ id, kind: 'app', ...app }]
  })
}

/**
 * Every place, in each kind's own order: the pages; the active Topics; the open threads (unread first, then newest),
 * each in its Topic's channel; the Apps; the Personas; and the sections of Settings and Work.
 */
export function jumpItems(sources: JumpSources): readonly JumpItem[] {
  const { topics, views } = sources
  const pages = [
    page('/activity', 'Activity'),
    page('/work', 'Work'),
    page('/apps', 'Apps'),
    page('/connections', 'Connections'),
    page('/personas', 'Personas'),
    page('/settings', 'Settings'),
    page('/threads', 'All threads'),
  ]
  const active = channels(topics).active.map((topic): JumpItem => ({
    id: `topic:${String(topic.id)}`,
    kind: 'topic',
    label: topic.name,
    detail: 'Topic',
    link: { to: '/c/$chatId', params: { chatId: topic.conversation } },
  }))
  const { unread, read } = threadList(views)
  const threads = [...unread, ...read].map((view): JumpItem => {
    const channel = channelOf(view.id, views, topics)
    const topic = topicOfChannel(channel, topics)
    return {
      id: `thread:${view.id}`,
      kind: 'thread',
      label: threadTitle(view),
      detail: topic === undefined ? 'Thread' : `Thread in #${topic.name}`,
      link: { to: '/c/$chatId', params: { chatId: channel }, search: { thread: Number(view.id) } },
    }
  })
  const personas = activePersonas(sources.personas).map((persona): JumpItem => ({
    id: `persona:${String(persona.id)}`,
    kind: 'persona',
    label: `@${persona.name}`,
    detail: 'Persona',
    link: { to: '/p/$id', params: { id: String(persona.id) } },
  }))
  const sections = SECTIONS.map(({ to, hash, label }): JumpItem => ({
    id: `section:${to}#${hash}`,
    kind: 'setting',
    label,
    detail: `Section in ${to === '/work' ? 'Work' : 'Settings'}`,
    link: { to, hash },
  }))
  return [...pages, ...active, ...threads, ...apps(sources), ...personas, ...sections]
}

/**
 * Text as a query compares it: lower case, without accents, and without a leading `#` or `@`, so "#trav" finds the
 * Travel Topic and "ana" finds `@ana`.
 */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[#@]+/u, '')

const WORD = /[\p{L}\p{N}]/u

/** How well a label matches a folded query: 0 at its start, 1 at a word's start, 2 anywhere; undefined not at all. */
function rank(label: string, query: string): number | undefined {
  const text = fold(label)
  if (text.startsWith(query)) return 0
  let best: number | undefined
  for (let at = text.indexOf(query); at > 0; at = text.indexOf(query, at + 1)) {
    if (!WORD.test(text.charAt(at - 1))) return 1
    best = 2
  }
  return best
}

/**
 * The switcher's results for `query`, grouped by kind with at most eight rows in each. A label that starts with the
 * query comes before one with a word that does, and that before one that only contains it, ignoring case and accents;
 * equal ones keep their kind's order and then their own. The group with the best match comes first. With no query:
 * the pages, then the Topics.
 */
export function jumpResults(items: readonly JumpItem[], query: string): readonly JumpGroup[] {
  const folded = fold(query.trim())
  const ranked =
    folded === ''
      ? items
          .filter((item) => item.kind === 'destination' || item.kind === 'topic')
          .map((item, order) => ({ item, score: 0, order }))
      : items.flatMap((item, order) => {
          const score = rank(item.label, folded)
          return score === undefined ? [] : [{ item, score, order }]
        })
  return GROUPS.flatMap((group, place) => {
    const matched = ranked
      .filter(({ item }) => item.kind === group.kind)
      .toSorted((a, b) => a.score - b.score || a.order - b.order)
      .slice(0, SHOWN)
    const [first] = matched
    return first === undefined ? [] : [{ group, place, best: first.score, items: matched.map(({ item }) => item) }]
  })
    .toSorted((a, b) => a.best - b.best || a.place - b.place)
    .map(({ group, items: shown }) => ({ kind: group.kind, label: group.label, items: shown }))
}
