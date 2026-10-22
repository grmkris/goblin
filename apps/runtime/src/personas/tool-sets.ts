import { and, eq, gte, inArray, lt, notInArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { appPersonaForkTools, appPersonaToolSets } from '../storage/persona-tools.ts'
import { appPersonaChats } from '../storage/personas.ts'

// The native tool sets Persona forks freeze (ADR 0101): stored once per distinct set, and the set each fork answers
// with. A plain store over the agent's database, read synchronously by the Pi kit at start, by the run recorder inside
// Pi's commits, and by the programs that resolve a native call.

type Db = DrizzleSqliteDODatabase

/**
 * One native tool as a fork froze it: its name, the server it calls (a connection, by id) and that server's name for
 * it, and the description and input schema the model reads, both cleaned (`pi/native-tools.ts`).
 */
export const FrozenTool = Schema.Struct({
  name: Schema.String,
  connectionId: Schema.String,
  tool: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Json),
  /** Not offered until `tool_search` loads it: a tool beyond the first 20, the Persona's own first (ADR 0102). */
  deferred: Schema.optionalKey(Schema.Literal(true)),
  /** The declared name of the server the fork's thread declared it from (ADR 0103); none for a connection's. */
  thread: Schema.optionalKey(Schema.String),
})
export type FrozenTool = typeof FrozenTool.Type

const decodeTools = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(FrozenTool)))

/** A frozen set: its id (the hash of its tools as stored) and its tools, ordered by name. */
export type ToolSet = { readonly id: string; readonly tools: readonly FrozenTool[] }

/** How long a fork's set is kept, in seconds: past it a fork that goes on again freezes a new one. */
export const SET_RETENTION = 30 * 86_400

/** A stored set's tools; none for a row that cannot be read, which then offers nothing. */
const toolsOf = (stored: string): readonly FrozenTool[] => Option.getOrElse(decodeTools(stored), () => [])

/** The tools of `set` as stored: the text its id is the hash of. */
export const storedTools = (tools: readonly FrozenTool[]): string => JSON.stringify(tools)

/**
 * Records that `chat` (a Persona fork) answers with `set`, kept once however many forks freeze it, and lets go of what
 * no fork made within {@link SET_RETENTION} uses any more.
 */
export function saveForkSet(db: Db, chat: string, set: ToolSet, now: number): void {
  db.transaction((tx) => {
    tx.insert(appPersonaToolSets)
      .values({ id: set.id, tools: storedTools(set.tools), createdAt: now })
      .onConflictDoNothing()
      .run()
    tx.insert(appPersonaForkTools)
      .values({ chatId: chat, setId: set.id, createdAt: now })
      .onConflictDoUpdate({ target: appPersonaForkTools.chatId, set: { setId: set.id, createdAt: now } })
      .run()
    tx.delete(appPersonaForkTools)
      .where(lt(appPersonaForkTools.createdAt, now - SET_RETENTION))
      .run()
    const used = tx.select({ id: appPersonaForkTools.setId }).from(appPersonaForkTools)
    tx.delete(appPersonaToolSets).where(notInArray(appPersonaToolSets.id, used)).run()
  })
}

/** The set fork `chat` answers with, when it froze one. */
export function forkSetOf(db: Db, chat: string): ToolSet | undefined {
  const row = db
    .select({ id: appPersonaToolSets.id, tools: appPersonaToolSets.tools })
    .from(appPersonaForkTools)
    .innerJoin(appPersonaToolSets, eq(appPersonaToolSets.id, appPersonaForkTools.setId))
    .where(eq(appPersonaForkTools.chatId, chat))
    .get()
  return row === undefined ? undefined : { id: row.id, tools: toolsOf(row.tools) }
}

/** The native tool called `name` in fork `chat`'s set, when it has one by that name. */
export const forkToolOf = (db: Db, chat: string, name: string): FrozenTool | undefined =>
  forkSetOf(db, chat)?.tools.find((tool) => tool.name === name)

/** Every set a fork frozen since `since` (seconds) answers with: what a starting agent installs before Pi opens. */
export function recentSets(db: Db, since: number): readonly ToolSet[] {
  const ids = db
    .selectDistinct({ id: appPersonaForkTools.setId })
    .from(appPersonaForkTools)
    .where(gte(appPersonaForkTools.createdAt, since))
  return db
    .select({ id: appPersonaToolSets.id, tools: appPersonaToolSets.tools })
    .from(appPersonaToolSets)
    .where(and(inArray(appPersonaToolSets.id, ids)))
    .all()
    .map((row) => ({ id: row.id, tools: toolsOf(row.tools) }))
}

/** The Persona that answers in `chat` (its fork), when one does. */
export const personaOfChat = (db: Db, chat: string): number | undefined =>
  db.select({ persona: appPersonaChats.personaId }).from(appPersonaChats).where(eq(appPersonaChats.chatId, chat)).get()
    ?.persona
