// What the sidebar keeps outside the workspace: the sections folded in this browser, whether it is collapsed to its
// strip, its counts, which row shows where the page is, and the threads this browser opened recently. Folds, the strip
// and recent threads are device conveniences, read through useSyncExternalStore so the server and the first render in
// the browser show none.
import { useMemo, useSyncExternalStore } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { pinKey } from '@goblin/contracts'
import { type Highlight, highlightOf } from '../../lib/nav-highlight.ts'
import { railCounts } from '../../lib/rail.ts'
import { recentThreads } from '../../lib/recent-threads.ts'
import { channelOf } from '../../lib/topics.ts'
import {
  useActivities,
  useApps,
  useConversations,
  useInvocations,
  useNotifications,
  useSidebarPins,
  useTopics,
} from '../../lib/workspace/hooks.ts'

/** What this visit folded, whether or not storage kept it, and who to tell when it changes. */
const foldedHere = new Map<string, boolean>()
const foldListeners = new Set<() => void>()
const subscribeFolds = (listener: () => void) => {
  foldListeners.add(listener)
  return () => {
    foldListeners.delete(listener)
  }
}
function storedFold(key: string): boolean {
  const chosen = foldedHere.get(key)
  if (chosen !== undefined) return chosen
  try {
    return localStorage.getItem(key) === 'folded'
  } catch {
    // expected: storage is off in this browser, so every section starts open
    return false
  }
}

/**
 * The sections the owner folded, remembered in this browser (a convenience: without storage they open on reload). The
 * server, and the first render in the browser, show them open; the browser's choice follows.
 */
export function useFolded(section: string): readonly [boolean, () => void] {
  const key = `goblin:sidebar:${section}`
  const folded = useSyncExternalStore(
    subscribeFolds,
    () => storedFold(key),
    () => false,
  )
  const toggle = () => {
    foldedHere.set(key, !folded)
    try {
      localStorage.setItem(key, folded ? 'open' : 'folded')
    } catch {
      // expected: storage is off or full; folding is a device preference only, kept for this visit
    }
    for (const listener of foldListeners) listener()
  }
  return [folded, toggle]
}

/**
 * The one row that shows where the page is (ADR 0078): a channel or thread, a pin, or one of the places. An App's page
 * marks its pin or Apps, never its Topic.
 */
export function useHighlight(): Highlight | undefined {
  const conversations = useConversations()
  const topics = useTopics()
  const apps = useApps()
  const stored = useSidebarPins()
  const path = useRouterState({ select: (router) => router.location.pathname })
  const thread = useRouterState({ select: (router) => router.location.search.thread })
  return useMemo(
    () =>
      highlightOf(
        { path, thread },
        {
          pins: new Set(stored.pins.map(pinKey)),
          apps,
          channelOf: (chat) => channelOf(chat, conversations, topics),
        },
      ),
    [path, thread, stored, apps, conversations, topics],
  )
}

/** The sidebar's counts (ADR 0078): what waits on the owner, the work under way, and the unread threads. */
export function useNavCounts(): ReturnType<typeof railCounts> {
  return railCounts({
    views: useConversations(),
    apps: useApps(),
    activity: useActivities(),
    invocations: useInvocations(),
    notifications: useNotifications(),
  })
}

/** Where the strip is remembered in this browser, and the script that puts it back before the first paint. */
const COLLAPSED = 'goblin:sidebar:collapsed'
export const COLLAPSE_SCRIPT = `(function(){try{if(localStorage.getItem('${COLLAPSED}')==='1')document.documentElement.dataset.sidebar='collapsed'}catch(e){}})()`

const collapseListeners = new Set<() => void>()
const subscribeCollapse = (listener: () => void) => {
  collapseListeners.add(listener)
  return () => {
    collapseListeners.delete(listener)
  }
}
const collapsedNow = () => document.documentElement.dataset.sidebar === 'collapsed'

/**
 * Whether the desktop sidebar is collapsed to its strip. The page itself carries it (`data-sidebar` on the root, set
 * before the first paint), so the server and the first render in the browser say open and the strip never flashes.
 */
export const useCollapsed = (): boolean => useSyncExternalStore(subscribeCollapse, collapsedNow, () => false)

/** Collapses the sidebar to its strip, or opens it again, and remembers that in this browser. */
export function toggleCollapsed(): void {
  const root = document.documentElement
  const collapse = !collapsedNow()
  if (collapse) root.dataset.sidebar = 'collapsed'
  else delete root.dataset.sidebar
  try {
    localStorage.setItem(COLLAPSED, collapse ? '1' : '0')
  } catch {
    // expected: storage is off or full; the strip is a device preference only, kept for this visit
  }
  for (const listener of collapseListeners) listener()
}

const NO_THREADS: ReadonlySet<string> = new Set()
const noSubscription = () => () => undefined
let recentRead: { readonly ids: string; readonly set: ReadonlySet<string> } = { ids: '', set: NO_THREADS }
/** The recent threads as stored now, the same set while they are the same. */
function storedRecent(): ReadonlySet<string> {
  const ids = recentThreads()
  if (ids.join(',') !== recentRead.ids) recentRead = { ids: ids.join(','), set: new Set(ids) }
  return recentRead.set
}

/**
 * The threads this browser opened recently, read again as the page changes (a device convenience). The server, and
 * the first render in the browser, know none.
 */
export function useRecentThreads(): ReadonlySet<string> {
  // Each page change renders this again, and so reads the store again.
  useRouterState({ select: (router) => router.location.href })
  return useSyncExternalStore(noSubscription, storedRecent, () => NO_THREADS)
}
