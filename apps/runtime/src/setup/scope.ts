import type { ToolRegistration } from '@earendil-works/pi-durable'
import {
  type ExclusionTarget,
  type ConversationKind,
  type HelperExclusion,
  type PersonaSetup,
  type SetupItem,
  type TopicSetup,
  handOverOf,
  hasApp,
  hasLibrary,
  hasServer,
  hasSkill,
  hasTool,
  holds,
  NOTHING,
} from '@goblin/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appHelperExclusions, appExecutionExclusions, appConversations } from '../storage/schema.ts'
import { appRoutineRuns, appRoutines } from '../storage/routines.ts'
import { appPersonaChats } from '../storage/personas.ts'
import { appTopics } from '../storage/topics.ts'
import { personaSetupOf } from '../personas/registry.ts'
import { topicSetupOf } from '../topics/setup.ts'
import { chatOfSession, chatSession } from '../chats/directory.ts'
import { InvalidInput } from '../http/errors.ts'
import { definitionOf } from '../routines/store.ts'
import { roomOf } from '../keys/made-by.ts'

type Kind = ExclusionTarget['kind']
type Db = DrizzleSqliteDODatabase

/**
 * A conversation's Pi tool filter: the subagent tools removed, or every tool a room does not offer (ADR 0108), or none
 * (`null` clears an inherited one).
 */
export type PiTools = { readonly remove: readonly ToolRegistration[] } | null

/**
 * The tools Pi's filter removes: the subagent tools where subagents are off, and in a room every tool it does not offer
 * (`pi/room.ts`, ADR 0108), the subagent tools among them. Pi stores a filter by name, so these are what it names.
 */
export type ToolSets = {
  readonly subagents: readonly ToolRegistration[]
  readonly room: readonly ToolRegistration[]
}

/** One thing switched off in a conversation, as stored: `connectionId` empty for subagents, `name` set only for a tool. */
export type Exclusion = { readonly kind: Kind; readonly connectionId: string; readonly name: string }

/** What one bound lets a chat use: its Topic's setup, the switches of a chat, a routine's allowed tools. */
type Allow = {
  readonly server: (connectionId: string) => boolean
  /** A tool is off when it or its server is. */
  readonly tool: (connectionId: string, name: string) => boolean
  /** Whether any skill of the server's library may be used: what reading its listing needs. */
  readonly skills: (connectionId: string) => boolean
  /** Whether this one skill may be used, by name and, when known, URI. */
  readonly skill: (connectionId: string, name: string, uri?: string) => boolean
  readonly subagents: () => boolean
  readonly app: (name: string) => boolean
}

/** The Topic a chat works in (ADR 0040), and whether its setup holds an item: a refusal says what held it back. */
export type ScopeTopic = {
  readonly id: number
  readonly name: string
  /** The channel guidance the owner wrote (ADR 0079); empty when there is none. */
  readonly description: string
  readonly instructions: string
  readonly holds: (item: SetupItem) => boolean
}

/**
 * What a chat's agent may use: its Topic's setup, narrowed by its switches and those of every spawner above a subagent,
 * and by a routine's allowed tools. The one gate every tool and section asks. It only chooses among the owner's grants,
 * which the MCP manager still checks. `editable`: the owner can act on a refusal here (not in a subagent, which follows
 * the chats above it). `topic` is the Topic whose setup bounds it. `room` is that Topic's id when it is a room (ADR
 * 0108): the chat reaches only it, whoever writes there, and never starts subagents or uses apps.
 */
export type SetupScope = Allow & { readonly editable: boolean; readonly topic?: ScopeTopic; readonly room?: number }

/** A conversation the agent does not know may use nothing. */
export const CLOSED: SetupScope = {
  editable: false,
  server: () => false,
  tool: () => false,
  skills: () => false,
  skill: () => false,
  subagents: () => false,
  app: () => false,
}

/** Everything both bounds allow. */
const both = (one: Allow, other: Allow): Allow => ({
  server: (connectionId) => one.server(connectionId) && other.server(connectionId),
  tool: (connectionId, name) => one.tool(connectionId, name) && other.tool(connectionId, name),
  skills: (connectionId) => one.skills(connectionId) && other.skills(connectionId),
  skill: (connectionId, name, uri) => one.skill(connectionId, name, uri) && other.skill(connectionId, name, uri),
  subagents: () => one.subagents() && other.subagents(),
  app: (name) => one.app(name) && other.app(name),
})

/**
 * What a setup lets a chat use: only what it holds. A Persona's setup never holds subagents. A Persona's own setup is
 * also what decides the tools it exposes (ADR 0101).
 */
export const setupAllows = (setup: TopicSetup | PersonaSetup): Allow => ({
  server: (connectionId) => hasServer(setup, connectionId),
  tool: (connectionId, name) => hasTool(setup, connectionId, name),
  skills: (connectionId) => hasLibrary(setup, connectionId),
  skill: (connectionId, name, uri) => hasSkill(setup, { connectionId, name, uri }),
  subagents: () => 'subagents' in setup && setup.subagents,
  app: (name) => hasApp(setup, name),
})

/** Everything either bound allows. */
const either = (one: Allow, other: Allow): Allow => ({
  server: (connectionId) => one.server(connectionId) || other.server(connectionId),
  tool: (connectionId, name) => one.tool(connectionId, name) || other.tool(connectionId, name),
  skills: (connectionId) => one.skills(connectionId) || other.skills(connectionId),
  skill: (connectionId, name, uri) => one.skill(connectionId, name, uri) || other.skill(connectionId, name, uri),
  subagents: () => one.subagents() || other.subagents(),
  app: (name) => one.app(name) || other.app(name),
})

const key = ({ kind, connectionId, name }: Exclusion) => `${kind}\n${connectionId}\n${name}`

/** The stored row for a target. */
export const exclusionOf = (target: ExclusionTarget): Exclusion => ({
  kind: target.kind,
  connectionId: target.kind === 'subagents' ? '' : target.connectionId,
  name: target.kind === 'tool' ? target.name : '',
})

/**
 * The scope that switches off everything in `exclusions` (the rows of a conversation and those above it) and the apps
 * in `appsOff`, and nothing else.
 */
export function scopeOf(
  exclusions: readonly Exclusion[],
  editable: boolean,
  appsOff: ReadonlySet<string> = new Set(),
): SetupScope {
  const off = new Set(exclusions.map(key))
  const server = (connectionId: string) => !off.has(key({ kind: 'server', connectionId, name: '' }))
  return {
    editable,
    server,
    tool: (connectionId, name) => server(connectionId) && !off.has(key({ kind: 'tool', connectionId, name })),
    skills: (connectionId) => !off.has(key({ kind: 'skills', connectionId, name: '' })),
    skill: (connectionId) => !off.has(key({ kind: 'skills', connectionId, name: '' })),
    subagents: () => !off.has(key({ kind: 'subagents', connectionId: '', name: '' })),
    app: (name) => !appsOff.has(name),
  }
}

// A helper's exclusions (`app_conversation_capabilities`, `app_execution_exclusions`) as functions of the agent's
// database: what its spawner switched off for it (`subagent_config`). A subagent is bounded by every chat above it, read
// live, so it can never do more than the one that started it. Owner chats have no rows: their Topic's setup is what
// they work with (ADR 0040).

/** One conversation in a chain of spawners. */
type Link = {
  readonly session: string
  readonly kind: ConversationKind
  readonly role: string | null
  readonly routineRunId: string | null
  readonly topicId: number
}

/** Called inside a short application transaction, including the first registration of a helper. */
export function writeHelperExclusions(
  db: Db,
  session: string,
  exclusions: readonly HelperExclusion[],
  now: number,
): void {
  db.delete(appHelperExclusions).where(eq(appHelperExclusions.sessionId, session)).run()
  db.delete(appExecutionExclusions).where(eq(appExecutionExclusions.sessionId, session)).run()
  for (const target of exclusions) {
    if (target.kind === 'app') {
      db.insert(appExecutionExclusions)
        .values({ sessionId: session, app: target.app, offAt: now })
        .onConflictDoNothing()
        .run()
    } else {
      db.insert(appHelperExclusions)
        .values({ sessionId: session, ...exclusionOf(target), offAt: now })
        .onConflictDoNothing()
        .run()
    }
  }
}

/** What a helper's spawner switched off for it. */
export const ownExclusions = (db: Db, session: string): readonly Exclusion[] =>
  db
    .select({
      kind: appHelperExclusions.kind,
      connectionId: appHelperExclusions.connectionId,
      name: appHelperExclusions.name,
    })
    .from(appHelperExclusions)
    .where(eq(appHelperExclusions.sessionId, session))
    .all()

const switchRow = (db: Db, session: string) =>
  db
    .select({
      kind: appConversations.kind,
      role: appConversations.role,
      parent: appConversations.parentSession,
      routineRunId: appConversations.routineRunId,
      topicId: appConversations.topicId,
    })
    .from(appConversations)
    .where(eq(appConversations.chatId, session))
    .get()

/**
 * The conversations whose switches bound `session`: it, then each spawner while that is a subagent, up to the first
 * conversation that is not (whose own switches are whole). Subagents nest without a depth limit; a conversation seen
 * twice or a subagent without a spawner breaks the chain (`undefined`), and a broken chain may use nothing.
 */
const chainOf = (db: Db, session: string): readonly Link[] | undefined => {
  const chain: Link[] = []
  const seen = new Set<string>()
  for (let at: string | null = session; at !== null && !seen.has(at);) {
    const row = switchRow(db, at)
    if (row === undefined) return undefined
    seen.add(at)
    chain.push({ session: at, kind: row.kind, role: row.role, routineRunId: row.routineRunId, topicId: row.topicId })
    if (row.kind !== 'subagent') return chain
    at = row.parent
  }
  return undefined
}

/**
 * A routine's thread may use only the tools its definition allows, within the scope it would have anyway (its Topic's
 * setup among the rest, ADR 0040, joined with its Persona's when it hands the work to one); never skills, subagents or
 * app powers.
 */
const routineScope = (db: Db, scope: SetupScope, runId: string): SetupScope => {
  const run = db.select().from(appRoutineRuns).where(eq(appRoutineRuns.id, runId)).get()
  if (run === undefined) return CLOSED
  const definition = definitionOf(run)
  const allowedTools = handOverOf(definition)?.allowedTools ?? []
  return {
    editable: false,
    ...(scope.topic === undefined ? {} : { topic: scope.topic }),
    ...(scope.room === undefined ? {} : { room: scope.room }),
    server: (id) => scope.server(id) && allowedTools.some((tool) => tool.connectionId === id),
    tool: (id, name) =>
      scope.tool(id, name) && allowedTools.some((tool) => tool.connectionId === id && tool.name === name),
    skills: () => false,
    skill: () => false,
    subagents: () => false,
    app: () => false,
  }
}

/** A Topic as a scope reads it, live: its name, guidance and setup. A Topic that is not there holds nothing. */
const topicOf = (db: Db, id: number): (ScopeTopic & { readonly setup: TopicSetup }) | undefined => {
  const row = db
    .select({
      name: appTopics.name,
      description: appTopics.description,
      instructions: appTopics.instructions,
      setup: appTopics.setup,
    })
    .from(appTopics)
    .where(eq(appTopics.id, id))
    .get()
  if (row === undefined) return undefined
  const setup = topicSetupOf(row.setup)
  return { id, ...row, setup, holds: (item) => holds(setup, item) }
}

/** The setup a Persona answers with in `chat` (its fork, or a routine's run handed to it); none in any other chat. */
const personaSetupIn = (db: Db, chat: string): PersonaSetup | undefined => {
  const row = db
    .select({ setup: appPersonaChats.setup })
    .from(appPersonaChats)
    .where(eq(appPersonaChats.chatId, chat))
    .get()
  return row === undefined ? undefined : personaSetupOf(row.setup)
}

/**
 * What a chat's root works with: its Topic's setup, joined, where a Persona answers (its fork, or a routine's run handed
 * to it at the pinned revision, ADR 0041), with the setup the Persona adds (ADR 0040). A Persona never starts subagents
 * and the owner never acts on a refusal there.
 */
const rootBound = (db: Db, root: Link, topic: ScopeTopic & { readonly setup: TopicSetup }) => {
  const bound = root.role === 'persona' || root.routineRunId !== null ? personaSetupIn(db, root.session) : undefined
  const added = root.role === 'persona' ? (bound ?? NOTHING) : bound
  if (added === undefined) return { allow: setupAllows(topic.setup), topic, persona: false }
  const allow = { ...either(setupAllows(topic.setup), setupAllows(added)), subagents: () => false }
  const holdsEither = (item: SetupItem) => topic.holds(item) || holds(added, item)
  return { allow, topic: { ...topic, holds: holdsEither }, persona: true }
}

/** The apps switched off in any of `sessions` (a helper's exclusions). */
const appsOffIn = (db: Db, sessions: readonly string[]): ReadonlySet<string> =>
  new Set(
    db
      .select({ app: appExecutionExclusions.app })
      .from(appExecutionExclusions)
      .where(inArray(appExecutionExclusions.sessionId, sessions))
      .all()
      .map(({ app }) => app),
  )

/**
 * The scope of a registered chat (ADR 0040): its Topic's setup, read live (joined, in a Persona's fork, with the setup
 * the ask froze), narrowed by its own switches and, for a subagent, those of every spawner above it; a routine's thread
 * is narrowed to its allowed tools as well. A chat whose chain's root is in a room (ADR 0108) says so, by place and
 * never by who writes: its Conversation, threads, subagents, Persona forks and routine runs, with subagents and apps
 * off whatever the setup holds.
 */
export const chatScope = (db: Db, chat: string): SetupScope => {
  const chain = chainOf(db, chat)
  const start = chain?.[0]
  const root = chain?.at(-1)
  if (chain === undefined || start === undefined || root === undefined) return CLOSED
  const found = topicOf(db, root.topicId)
  if (found === undefined) return CLOSED
  const { allow, topic, persona } = rootBound(db, root, found)
  const editable = start.kind !== 'subagent' && start.routineRunId === null && !persona
  const switches = scopeOf(
    chain.flatMap((link) => ownExclusions(db, link.session)),
    editable,
    appsOffIn(
      db,
      chain.map((link) => link.session),
    ),
  )
  const bound: SetupScope = { ...both(allow, switches), editable, topic }
  const scope: SetupScope = roomOf(db, root.topicId)
    ? { ...bound, subagents: () => false, app: () => false, room: root.topicId }
    : bound
  return root.routineRunId === null ? scope : routineScope(db, scope, root.routineRunId)
}

/** The scope of the chat a Pi session belongs to; a session no chat owns may use nothing. */
export const sessionScope = (db: Db, session: string): SetupScope => {
  const chat = chatOfSession(db, session)
  return chat === undefined ? CLOSED : chatScope(db, chat)
}

/** App calls follow the same live chain and Topic setup as MCP and skills; routine scopes do not acquire app powers. */
export const appAllowed = (db: Db, session: string, app: string): boolean => sessionScope(db, session).app(app)

/**
 * Pi's tool filter for `chat`: in a room (ADR 0108) without every tool a room does not offer, else without the subagent
 * tools when subagents are off where it works, else none.
 */
export const piToolsFor = (db: Db, toolSets: ToolSets, chat: string): PiTools => {
  const scope = chatScope(db, chat)
  if (scope.room !== undefined) return { remove: toolSets.room }
  return scope.subagents() ? null : { remove: toolSets.subagents }
}

/**
 * What applying the switches to Pi takes: the database, the tools Pi's tool filter removes (`ToolSets`), and `retool`,
 * which sets a Pi conversation's filter (outside any SQLite transaction).
 */
export type Retooling = {
  readonly db: Db
  readonly toolSets: ToolSets
  readonly retool: (session: string, tools: PiTools) => Promise<void>
}

/** Applies `session`'s tool filter to its Pi conversation, after the switches are stored. */
export const syncPi = async ({ db, toolSets, retool }: Retooling, session: string): Promise<void> => {
  await retool(chatSession(db, session), piToolsFor(db, toolSets, session))
}

/** Only the direct parent can configure a registered helper. Exclusions cannot widen any ancestor's ceiling. */
export const configureHelper = async (
  retooling: Retooling,
  helper: { readonly parent: string; readonly session: string; readonly exclusions: readonly HelperExclusion[] },
  now: number,
): Promise<void> => {
  const { db } = retooling
  const chat = chatOfSession(db, helper.session)
  const parentChat = chatOfSession(db, helper.parent)
  const row = chat === undefined ? undefined : switchRow(db, chat)
  if (chat === undefined || parentChat === undefined || row?.kind !== 'subagent' || row.parent !== parentChat)
    throw new InvalidInput({ reason: 'helper_parent' })
  db.transaction(() => writeHelperExclusions(db, chat, helper.exclusions, now))
  await syncPi(retooling, chat)
}

/**
 * Whether a chat's Pi filter follows its scope: all but Persona forks and routine runs, whose filters are set when they
 * are made (a Persona's leaves out the tools it never has).
 */
const followsScope = (row: { readonly role: string | null; readonly run: string | null }): boolean =>
  row.role !== 'persona' && row.run === null

/**
 * The registered chats whose Pi tool filter follows their scope. A chat not registered yet (a new agent's main) has
 * nothing to apply.
 */
const filteredChats = (db: Db): readonly string[] =>
  db
    .select({ chat: appConversations.chatId, role: appConversations.role, run: appConversations.routineRunId })
    .from(appConversations)
    .all()
    .filter(followsScope)
    .map((row) => row.chat)

/** Whether registered chat `chat`'s Pi filter follows its scope (`followsScope`); an unknown one's does not. */
export const filterFollowsScope = (db: Db, chat: string): boolean => {
  const row = db
    .select({ role: appConversations.role, run: appConversations.routineRunId })
    .from(appConversations)
    .where(eq(appConversations.chatId, chat))
    .get()
  return row !== undefined && followsScope(row)
}

/**
 * Applies the Pi filter again to every chat of `topic` whose filter follows its scope, after its setup's subagents
 * changed (ADR 0040) or it became a room (ADR 0108). One that fails to apply is left as it was; the next change, or
 * the chat's next turn after a restart (`useRoomTools`), applies it again.
 */
export const retoolTopic = async (retooling: Retooling, topic: number): Promise<void> => {
  const { db, toolSets, retool } = retooling
  const inTopic = new Set(
    db
      .select({ chat: appConversations.chatId })
      .from(appConversations)
      .where(eq(appConversations.topicId, topic))
      .all()
      .map(({ chat }) => chat),
  )
  for (const chat of filteredChats(db).filter((each) => inTopic.has(each)))
    await retool(chatSession(db, chat), piToolsFor(db, toolSets, chat))
}

/** The routines a setup would leave without some of their allowed tools: the ones not done, of `topic`. */
export const routinesOutside = (db: Db, topic: number, setup: TopicSetup) =>
  db
    .select()
    .from(appRoutines)
    .where(
      and(eq(appRoutines.topicId, topic), inArray(appRoutines.state, ['proposed', 'activating', 'active', 'paused'])),
    )
    .all()
    .flatMap((routine) => {
      const definition = definitionOf(routine)
      const outside = (handOverOf(definition)?.allowedTools ?? [])
        .filter((tool) => !hasTool(setup, tool.connectionId, tool.name))
        .map(({ connectionId, name }) => ({ connectionId, name }))
      return outside.length === 0 ? [] : [{ id: routine.id, title: definition.title, outside }]
    })
