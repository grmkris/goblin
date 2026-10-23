/**
 * A grant's reach as the editor shows and changes it (ADR 0114): which workspaces it reaches and, in each, its Topics,
 * Personas and connections as all or a list, plus the MCP servers it may bring. Pure: the editor's controls call these,
 * and the summary line says the reach in words with `describeReach`.
 */
import type { GoblinReach, ReachList, WorkspaceReach } from '@goblin/contracts'

/** Where a workspace's id comes with its name. */
type Named = { readonly id: string; readonly name: string }

/** The three kinds one workspace's reach lists, in the order the editor shows them. */
export const REACH_KINDS = ['topics', 'personas', 'connections'] as const satisfies readonly (keyof WorkspaceReach)[]
export type ReachField = (typeof REACH_KINDS)[number]

const NOUNS: Readonly<Record<ReachField, readonly [one: string, many: string]>> = {
  topics: ['Topic', 'Topics'],
  personas: ['Persona', 'Personas'],
  connections: ['connection', 'connections'],
}

/** Everything in `workspace`. */
export const everything = (workspace: string): WorkspaceReach => ({
  workspace,
  topics: { kind: 'all' },
  personas: { kind: 'all' },
  connections: { kind: 'all' },
})

const isEverything = (entry: WorkspaceReach): boolean => REACH_KINDS.every((field) => entry[field].kind === 'all')

/** What `reach` holds for `workspace`: its own entry, or everything in it (a grant over all workspaces names few). */
export const entryOf = (reach: GoblinReach, workspace: string): WorkspaceReach =>
  reach.each.find((entry) => entry.workspace === workspace) ?? everything(workspace)

/**
 * `reach` with `entry` for its workspace. Over all workspaces, an entry with everything in it is the default and is left
 * out; a listed workspace keeps its entry whatever it holds.
 */
export const withEntry = (reach: GoblinReach, entry: WorkspaceReach): GoblinReach => {
  const others = reach.each.filter((each) => each.workspace !== entry.workspace)
  const keep = reach.workspaces === 'list' || !isEverything(entry)
  const at = reach.each.findIndex((each) => each.workspace === entry.workspace)
  const each = keep
    ? at === -1
      ? [...others, entry]
      : reach.each.map((old, index) => (index === at ? entry : old))
    : others
  return { ...reach, each }
}

/** The ids of `workspaces` that `reach` reaches: all of them, or those it lists. */
export const reachedWorkspaces = (
  reach: GoblinReach,
  workspaces: readonly { readonly id: string }[],
): readonly string[] =>
  reach.workspaces === 'all' ? workspaces.map((workspace) => workspace.id) : reach.each.map((entry) => entry.workspace)

/**
 * `reach` over every workspace of the person's (`all`, ones they join later included), or over exactly `ids`. Each
 * workspace keeps what it held; one newly listed holds everything until it is narrowed.
 */
export const withWorkspaces = (reach: GoblinReach, chosen: 'all' | readonly string[]): GoblinReach => {
  if (chosen === 'all') return { ...reach, workspaces: 'all', each: reach.each.filter((entry) => !isEverything(entry)) }
  return { ...reach, workspaces: 'list', each: chosen.map((id) => entryOf(reach, id)) }
}

/** One kind in words: "all Topics", "2 Topics", "1 connection", "no Personas". */
const countOf = (list: ReachList<string>, field: ReachField): string => {
  const [one, many] = NOUNS[field]
  if (list.kind === 'all') return `all ${many}`
  if (list.ids.length === 0) return `no ${many}`
  return `${String(list.ids.length)} ${list.ids.length === 1 ? one : many}`
}

/** `items` as one phrase: "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

/** What one workspace's entry reaches, in words: "everything", or each kind's count. */
export const entryWords = (entry: WorkspaceReach): string =>
  isEverything(entry) ? 'everything' : listed(REACH_KINDS.map((field) => countOf(entry[field], field)))

/**
 * `reach` in words, as the summary line says it after "can write": "everything in all your workspaces", "2 Topics,
 * all Personas and all connections in Acme". `within` names the one workspace a key lives in; its reach is said
 * without it. The MCP servers it may bring come last.
 */
export const describeReach = (reach: GoblinReach, workspaces: readonly Named[], within?: string): string => {
  const nameOf = (id: string) => workspaces.find((workspace) => workspace.id === id)?.name ?? 'a workspace you left'
  const bring =
    reach.origins.length === 0
      ? ''
      : `, and may bring ${String(reach.origins.length)} MCP server${reach.origins.length === 1 ? '' : 's'}`
  if (within !== undefined) return `${entryWords(entryOf(reach, within))}${bring}`
  if (reach.workspaces === 'all') {
    const narrowed = reach.each.filter((entry) => !isEverything(entry))
    const except =
      narrowed.length === 0
        ? ''
        : ` (${narrowed.map((entry) => `${entryWords(entry)} in ${nameOf(entry.workspace)}`).join('; ')})`
    return `everything in all your workspaces${except}${bring}`
  }
  if (reach.each.length === 0) return `nothing${bring}`
  const phrases = reach.each.map((entry) => ({ words: entryWords(entry), name: nameOf(entry.workspace) }))
  const same = phrases.every((phrase) => phrase.words === phrases[0]?.words)
  const words = same
    ? `${phrases[0]?.words ?? ''} in ${listed(phrases.map((phrase) => phrase.name))}`
    : phrases.map((phrase) => `${phrase.words} in ${phrase.name}`).join('; ')
  return `${words}${bring}`
}

/** Whether `reach` reaches anything at all: some workspace. */
export const reachesAnything = (reach: GoblinReach): boolean => reach.workspaces === 'all' || reach.each.length > 0
