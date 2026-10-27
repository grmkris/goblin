/**
 * The widening page (`/consent/widen`, ADR 0114): a refusal's link names the grant and what it lacked, and the page asks
 * the person to approve exactly that on top of what the grant holds now. Pure: reading the link, and the terms it asks
 * for.
 */
import {
  type ConsentTerms,
  Extra,
  GRANT_SPEC,
  type GoblinReach,
  type GrantTerms,
  Level,
  ReachKind,
  levelAtLeast,
} from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { FIELD_OF, entryOf, everything, withEntry } from './grant-reach.ts'

/** What the link carries: the grant, and the level, reach item, extra or new thing it was refused for. */
export interface WidenSearch {
  readonly grant?: string
  readonly level?: Level
  readonly reach?: string
  readonly extra?: Extra
  readonly create?: string
}

const isLevel = Schema.is(Level)
const isExtra = Schema.is(Extra)
const isKind = Schema.is(ReachKind)
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= max ? value : undefined

/** The link's terms, each one dropped when it is not one the grant contract knows. */
export const parseWiden = (search: Record<string, unknown>): WidenSearch => {
  const grant = text(search['grant'], 200)
  const reach = text(search['reach'], 400)
  const create = text(search['create'], 200)
  const { level, extra } = search
  return {
    ...(grant === undefined ? {} : { grant }),
    ...(isLevel(level) ? { level } : {}),
    ...(reach === undefined ? {} : { reach }),
    ...(isExtra(extra) ? { extra } : {}),
    ...(create === undefined ? {} : { create }),
  }
}

/** A reach id (`<workspace>/<kind>/<id>`, or a bare workspace) taken apart; none when it does not parse. */
export const reachItemOf = (
  reachId: string,
):
  | { readonly workspace: string; readonly kind?: undefined }
  | { readonly workspace: string; readonly kind: ReachKind; readonly id: string }
  | undefined => {
  const [workspace = '', kind, id, ...rest] = reachId.split('/')
  if (workspace === '' || rest.length > 0) return undefined
  if (kind === undefined) return { workspace }
  return isKind(kind) && id !== undefined && id !== '' ? { workspace, kind, id } : undefined
}

/**
 * `reach` widened by one reach id and nothing more. A bare workspace it does not list joins whole, every Topic, Persona
 * and connection in it (ADR 0127: a client asks for a workspace its person belongs to). An item in a workspace it does
 * not list joins it with nothing else, and an item in one it lists joins its kind's list. What it already reaches stays
 * as it is.
 */
export const withReachId = (reach: GoblinReach, reachId: string): GoblinReach => {
  const item = reachItemOf(reachId)
  if (item === undefined) return reach
  const listed = reach.workspaces === 'all' || reach.each.some((entry) => entry.workspace === item.workspace)
  const none = { kind: 'list', ids: [] } as const
  const entry = listed
    ? entryOf(reach, item.workspace)
    : { workspace: item.workspace, topics: none, personas: none, connections: none }
  if (item.kind === undefined) return listed ? reach : withEntry(reach, everything(item.workspace))
  const field = FIELD_OF[item.kind]
  const list = entry[field]
  if (list.kind === 'all' || list.ids.includes(item.id)) return listed ? reach : withEntry(reach, entry)
  return withEntry(reach, { ...entry, [field]: { kind: 'list', ids: [...list.ids, item.id] } })
}

/** `current` with what the link asks for added: the higher level, the extra and the reach item. Nothing is taken away. */
export const widened = (current: GrantTerms, search: WidenSearch): GrantTerms => ({
  ...current,
  level:
    search.level === undefined || levelAtLeast(GRANT_SPEC, current.level, search.level) ? current.level : search.level,
  extras:
    search.extra === undefined || current.extras.includes(search.extra)
      ? current.extras
      : [...current.extras, search.extra],
  reach: search.reach === undefined ? current.reach : withReachId(current.reach, search.reach),
})

/**
 * Whether `requested` (`widened` of `current`) adds nothing: a link that names no level, extra or reach item, or only
 * ones the grant holds already. `widened` keeps each part it leaves alone as it was, so the parts compare by identity.
 */
export const addsNothing = (current: GrantTerms, requested: GrantTerms): boolean =>
  requested.level === current.level && requested.extras === current.extras && requested.reach === current.reach

/**
 * What the page compares: only a live grant of the person's, the very one the link names, can be widened (myapps'
 * `wideningGrant`, 3b94a770); otherwise none.
 */
export const wideningOf = (consent: ConsentTerms, search: WidenSearch) => {
  const { current, summary, grantId } = consent
  if (current === null || summary === undefined || grantId === undefined || grantId !== search.grant) return null
  return { grantId, summary, current, requested: widened(current, search) }
}

const KIND_WORDS: Readonly<Record<ReachKind, string>> = {
  topic: 'Topic',
  persona: 'Persona',
  connection: 'The connection',
}

/**
 * The names the page could read for a reach id's workspace and its Topic, Persona or connection; one it could not read
 * is said by its id instead.
 */
export interface AskedNames {
  readonly workspace?: string | undefined
  readonly item?: string | undefined
}

/**
 * What else the link asks for, in words, beside a level and extras: the reach item it was refused (when approving
 * adds it), by its name and its workspace's, and something it wants to make.
 */
export const askedWords = (
  search: WidenSearch,
  current: GrantTerms,
  requested: GrantTerms,
  names: AskedNames,
): readonly string[] => {
  const item = search.reach === undefined ? undefined : reachItemOf(search.reach)
  const adds = item !== undefined && JSON.stringify(current.reach) !== JSON.stringify(requested.reach)
  const where = names.workspace ?? item?.workspace ?? ''
  const what = (id: string) => (names.item === undefined ? id : `“${names.item}”`)
  return [
    ...(adds && item.kind === undefined
      ? [`The whole workspace ${where}: every Topic, Persona and connection in it`]
      : []),
    ...(adds && item.kind !== undefined ? [`${KIND_WORDS[item.kind]} ${what(item.id)} in ${where}`] : []),
    ...(search.create === undefined ? [] : [`To make “${search.create}”`]),
  ]
}
