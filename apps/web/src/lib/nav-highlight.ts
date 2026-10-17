// Which row of the sidebar shows where the page is (ADR 0078): exactly one, the most specific that matches. A row that
// is the page is current (`page`); a place that only holds it (Apps, while a page of one of its apps shows) is marked
// as holding it (`true`). A Topic is never marked while an App's page shows. Pure.
import type { AppView } from '@goblin/contracts'

/** A row of the sidebar: a Topic's channel, a thread, a pin (by its `pinKey`) or one of the places. */
export type NavRow =
  | `topic:${string}`
  | `thread:${string}`
  | `pin:${string}`
  | 'activity'
  | 'work'
  | 'apps'
  | 'threads'
  | 'connections'
  | 'personas'
  | 'settings'

/** The row that shows where the page is, and whether it is the page or holds it. */
export type Highlight = { readonly row: NavRow; readonly current: 'page' | 'true' }

/** Where the page is: its path, and the thread its channel shows in the panel. */
export type NavPlace = { readonly path: string; readonly thread?: number | undefined }

/** What the rule reads: the pins' keys, the kept Apps, and the channel a chat belongs to. */
export type NavFacts = {
  readonly pins: ReadonlySet<string>
  readonly apps: readonly AppView[]
  readonly channelOf: (chat: string) => string | undefined
}

const PLACES: readonly (readonly [string, NavRow])[] = [
  ['/activity', 'activity'],
  ['/work', 'work'],
  ['/tasks', 'work'],
  ['/apps', 'apps'],
  ['/threads', 'threads'],
  ['/connections', 'connections'],
  ['/personas', 'personas'],
  ['/settings', 'settings'],
]

const page = (row: NavRow): Highlight => ({ row, current: 'page' })
const holding = (row: NavRow): Highlight => ({ row, current: 'true' })

/** An App's page: its pin when it is pinned (as a view, or as its server's own App), otherwise Apps, holding it. */
function appPage(id: string, facts: NavFacts): Highlight {
  if (facts.pins.has(`view:${id}`)) return page(`pin:view:${id}`)
  const app = facts.apps.find((each) => each.id === id)
  if (app?.source.kind === 'mcp' && app.source.entrypoint === true) {
    const key = `server:${app.source.connectionId}`
    if (facts.pins.has(key)) return page(`pin:${key}`)
  }
  return holding('apps')
}

/** A chat's page: the thread its panel shows, else the chat itself as a channel or a thread. */
function chatPage(id: string, thread: number | undefined, facts: NavFacts): Highlight {
  if (thread !== undefined) return page(`thread:${String(thread)}`)
  const channel = facts.channelOf(id)
  return page(channel === undefined || channel === id ? `topic:${id}` : `thread:${id}`)
}

/** A connection's own App (`/connections/<id>/app`): its server's pin, else Apps, holding it. */
function serverAppPage(connectionId: string, facts: NavFacts): Highlight {
  const key = `server:${connectionId}`
  return facts.pins.has(key) ? page(`pin:${key}`) : holding('apps')
}

/** One of the places, as the page on its own path and holding the pages under it. */
function placeOf(path: string): Highlight | undefined {
  for (const [prefix, row] of PLACES) {
    if (path === prefix) return page(row)
    if (path.startsWith(`${prefix}/`)) return holding(row)
  }
  return undefined
}

/** The row for `place`; none for a page outside the sidebar's places. */
export function highlightOf(place: NavPlace, facts: NavFacts): Highlight | undefined {
  const [, first = '', id = '', rest] = place.path.split('/')
  if (first === 'c' && id !== '') return chatPage(id, place.thread, facts)
  if (first === 'a' && id !== '') return appPage(id, facts)
  if (first === 'connections' && rest === 'app') return serverAppPage(id, facts)
  if (first === 'p') return holding('personas')
  return placeOf(place.path)
}
