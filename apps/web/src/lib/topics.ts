import {
  type ConversationView,
  EVERYTHING,
  PERSONAL_TOPIC,
  PRIMARY_CHAT,
  type TopicView,
  type UpdateTopic,
} from '@goblin/contracts'
import { isClosed, isUnread } from './threads.ts'
import { type Activity, activityOf } from './workspace/slices.ts'

/** Personal as a server without Topics implies it: the one Topic, whose Conversation is Main (`/c/1`). */
export const PERSONAL: TopicView = {
  id: PERSONAL_TOPIC,
  name: 'Personal',
  conversation: PRIMARY_CHAT,
  personal: true,
  reach: 'hub',
  revision: 0,
  setup: EVERYTHING,
  createdBy: 'system',
  createdAt: 0,
}

/** The owner's Topics as the feed lists them, or Personal alone before it has. */
export const topicsOf = (topics: readonly TopicView[]): readonly TopicView[] =>
  topics.length === 0 ? [PERSONAL] : topics

export const isArchived = (topic: TopicView): boolean => topic.archivedAt !== undefined

/** When a chat was last active: its last reply, or its start. */
const latest = (view: ConversationView) => view.lastReplyAt ?? view.createdAt

const byName = (a: TopicView, b: TopicView) =>
  Number(b.personal === true) - Number(a.personal === true) ||
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  a.id - b.id

/**
 * The server's key that made a Topic, by its name, or none for the owner's own (ADR 0115). For display only: the
 * sidebar keeps the many Topics a server makes for its customers apart, and nothing a Topic may do depends on it.
 */
export const madeByKey = (topic: TopicView): string | undefined => topic.madeBy?.key

/**
 * The sidebar's channels: the owner's own active Topics, Personal first and then by name, and apart from them the
 * archived ones. The Topics a server's key made are not among them: `madeByGroups` lists those.
 */
export function channels(topics: readonly TopicView[]): {
  readonly active: readonly TopicView[]
  readonly archived: readonly TopicView[]
} {
  const all = topicsOf(topics)
    .filter((topic) => madeByKey(topic) === undefined)
    .toSorted(byName)
  return { active: all.filter((topic) => !isArchived(topic)), archived: all.filter(isArchived) }
}

/** The Topics one key made: the key's name, its active Topics with the latest active first, and when that was. */
export type MadeByGroup = { readonly key: string; readonly topics: readonly TopicView[]; readonly latest: number }

/** When each channel was last active: its own last reply or start, or a later one in a thread right under it. */
function lastActive(views: readonly ConversationView[]): ReadonlyMap<string, number> {
  const last = new Map<string, number>()
  for (const view of views) {
    const channel = isChannel(view) ? view.id : view.parent
    if (channel !== undefined) last.set(channel, Math.max(last.get(channel) ?? 0, latest(view)))
  }
  return last
}

/**
 * The active Topics servers' keys made, one group per key, the group with the latest activity first and in each the
 * Topic with the latest activity first (one with no chat yet counts from when it was made). An archived one is in none.
 */
export function madeByGroups(topics: readonly TopicView[], views: readonly ConversationView[]): readonly MadeByGroup[] {
  const last = lastActive(views)
  const at = (topic: TopicView) => Math.max(last.get(topic.conversation) ?? 0, topic.createdAt)
  const byKey = new Map<string, TopicView[]>()
  for (const topic of topics) {
    const key = madeByKey(topic)
    if (key === undefined || isArchived(topic)) continue
    const group = byKey.get(key)
    if (group === undefined) byKey.set(key, [topic])
    else group.push(topic)
  }
  return [...byKey]
    .map(([key, made]) => {
      const sorted = made.toSorted((a, b) => at(b) - at(a) || b.id - a.id)
      return { key, topics: sorted, latest: Math.max(...sorted.map(at)) }
    })
    .toSorted((a, b) => b.latest - a.latest || a.key.localeCompare(b.key))
}

/** How far a Topic's chats reach (ADR 0115), in the words its channel info says it. */
export const reachNote = (topic: Pick<TopicView, 'reach'>): string =>
  topic.reach === 'hub'
    ? 'goblin here reaches every Topic of this workspace, its chats and files included.'
    : "goblin here sees only this Topic's chats and files, and the Shared folder on a person's turn."

/** The change that makes a Topic a hub (`true`) or seals it. */
export const reachChange = (hub: boolean): UpdateTopic => ({ reach: hub ? 'hub' : 'sealed' })

/** The Topics whose name holds `filter`, whatever the case; all of them while it is blank. */
export function matchingTopics(topics: readonly TopicView[], filter: string): readonly TopicView[] {
  const wanted = filter.trim().toLocaleLowerCase()
  return wanted === '' ? topics : topics.filter((topic) => topic.name.toLocaleLowerCase().includes(wanted))
}

/** Whether a chat is a Topic's one Conversation (its channel) rather than a thread or a subagent. */
export const isChannel = (view: ConversationView): boolean => view.conversation === true || view.kind === 'main'

/**
 * The channel a chat belongs to: itself when it is one, else its Topic's Conversation, else the nearest channel above
 * it, else Personal's. Stored parents that loop end the walk instead of looping.
 */
export function channelOf(id: string, views: readonly ConversationView[], topics: readonly TopicView[]): string {
  const byId = new Map(views.map((view) => [view.id, view]))
  const seen = new Set<string>()
  for (let view = byId.get(id); view !== undefined && !seen.has(view.id); view = byId.get(view.parent ?? '')) {
    if (isChannel(view)) return view.id
    const topic = view.topic === undefined ? undefined : topicsOf(topics).find(({ id: each }) => each === view.topic)
    if (topic !== undefined) return topic.conversation
    seen.add(view.id)
  }
  return PRIMARY_CHAT
}

/** The Topic whose Conversation `channel` is; Personal for Main on a server without Topics. */
export const topicOfChannel = (channel: string, topics: readonly TopicView[]): TopicView | undefined =>
  topicsOf(topics).find((topic) => topic.conversation === channel)

/** How many of a Topic's threads the sidebar lists under it. */
const LISTED = 5

/**
 * The threads the sidebar lists under a Topic's channel, one flat level: those at work, with unread replies, recently
 * opened here, or showing now, newest first. A closed one is not listed; the Threads page has every one.
 */
export function topicThreads(
  channel: string,
  views: readonly ConversationView[],
  topics: readonly TopicView[],
  activity: Activity,
  recent: ReadonlySet<string>,
): ConversationView[] {
  return views
    .filter(
      (view) =>
        !isChannel(view) &&
        !isClosed(view) &&
        (activityOf(activity, view.id) !== undefined || isUnread(view) || recent.has(view.id)) &&
        channelOf(view.id, views, topics) === channel,
    )
    .toSorted((a, b) => latest(b) - latest(a) || Number(b.id) - Number(a.id))
    .slice(0, LISTED)
}
