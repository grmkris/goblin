// What Apps lists (ADR 0078): the owner's pins with what opening each does, the tool-result views they may want again,
// the connections with an App of their own, and the apps built for them, each found by its name or its connection's
// label. Nothing here is stored: Recent is derived from the kept Apps each time. Pure.
import type {
  AgentAppSummary,
  AppView,
  ConversationView,
  ServerView,
  SidebarTarget,
  TopicView,
} from '@goblin/contracts'
import { jobTrouble } from './app-jobs.ts'
import type { PinState, ShownPin } from './pins.ts'
import { channelOf, isChannel, topicOfChannel } from './topics.ts'

/** How many tool-result views Recent lists. */
const RECENT = 6

const newestFirst = (a: AppView, b: AppView) => b.createdAt - a.createdAt || Number(b.id) - Number(a.id)

/**
 * The tool-result views Recent lists: open MCP App views kept in conversations, not a server's own App and not pinned,
 * newest first, only the newest of each connection's tool, six at most. Older ones stay in their conversation.
 */
export function recentViews(
  apps: readonly AppView[],
  isPinned: (target: SidebarTarget) => boolean,
): readonly AppView[] {
  const tools = new Set<string>()
  const recent: AppView[] = []
  for (const app of apps.toSorted(newestFirst)) {
    if (recent.length === RECENT) break
    if (app.source.kind !== 'mcp' || app.source.entrypoint === true || app.closedAt !== undefined) continue
    if (isPinned({ kind: 'view', appId: app.id })) continue
    const tool = `${app.source.connectionId}\u0000${app.source.tool}`
    if (tools.has(tool)) continue
    tools.add(tool)
    recent.push(app)
  }
  return recent
}

/** A connection with an App of its own (the entrypoint its server declares), as Apps lists it. */
export type ConnectedApp = {
  readonly connectionId: string
  /** What the server calls itself, else the owner's label. */
  readonly title: string
  /** The owner's name for the connection, which tells two accounts on one service apart. */
  readonly label: string
  /** Whether it opens now; one that does not is signed out and offers Reconnect. */
  readonly connected: boolean
}

/**
 * The connections whose App the owner opens on its own, in the list's order: every one whose server declares an
 * entrypoint, signed in or not, so a signed-out one can be reconnected from here. Two connections to one service are
 * two entries; a server with tools and no App of its own is only on Connections.
 */
export const connectedApps = (servers: readonly ServerView[]): readonly ConnectedApp[] =>
  servers
    .filter((server) => server.entrypoint !== undefined)
    .map((server) => ({
      connectionId: server.connectionId,
      title: server.title ?? server.label,
      label: server.label,
      connected: server.status === 'connected',
    }))

/**
 * Whether an item matches what the owner typed into Apps' search: anywhere in its name or in its connection's label,
 * in any case. Nothing typed matches everything.
 */
export function matches(search: string, name: string, label?: string): boolean {
  const wanted = search.trim().toLocaleLowerCase()
  return wanted === '' || [name, label ?? ''].some((text) => text.toLocaleLowerCase().includes(wanted))
}

/** The connection a pin opens through, whose label search also finds it by: its server, or its view's server. */
export const pinConnection = (pin: ShownPin): string | undefined =>
  pin.kind === 'server' ? pin.connectionId : pin.app?.source.kind === 'mcp' ? pin.app.source.connectionId : undefined

/**
 * What a pin's Open does: `open` its page (also while its server is still being read), `reopen` a closed view before
 * opening it, `reconnect` a signed-out server; nothing for a pin whose server has no App any more or that is gone, which
 * the owner can only unpin.
 */
export function pinAction(state: PinState): 'open' | 'reopen' | 'reconnect' | undefined {
  if (state === 'ready' || state === 'loading') return 'open'
  if (state === 'closed') return 'reopen'
  return state === 'signed-out' ? 'reconnect' : undefined
}

/** Why a pin does not open as it is, in the owner's words; nothing when it does. */
export function pinNote(state: PinState): string | undefined {
  if (state === 'signed-out') return 'Signed out'
  if (state === 'no-app') return 'No app any more'
  if (state === 'closed') return 'Closed'
  return state === 'gone' ? 'Not available' : undefined
}

/**
 * Where a view was kept, as Apps says it: "From #Travel" for a channel, "From" a thread's title, or "From a thread in
 * #Travel" for one without a title. Nothing for a conversation the feed does not list.
 */
export function cameFrom(
  conversation: string,
  views: readonly ConversationView[],
  topics: readonly TopicView[],
): string | undefined {
  const view = views.find((each) => each.id === conversation)
  if (view === undefined) return undefined
  const topic = topicOfChannel(channelOf(conversation, views, topics), topics)?.name ?? 'Personal'
  if (isChannel(view)) return `From #${topic}`
  return view.title === undefined ? `From a thread in #${topic}` : `From ${view.title}`
}

/** What a built app needs from the owner, if anything: powers to allow, a schedule in trouble, a failure. */
export function needsYou(app: AgentAppSummary): string | undefined {
  if (app.waiting > 0) return `${String(app.waiting)} to allow`
  if (app.jobs.some(jobTrouble)) return 'Schedule needs you'
  return app.failure === null ? undefined : 'Failing'
}
