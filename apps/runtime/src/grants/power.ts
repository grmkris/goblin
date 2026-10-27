import { Extra, GRANT_SPEC, Level, ROLE_POWER, type WorkspaceRole, levelAtLeast } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { Credential } from '../http/api/principal.ts'
import type { Boundary } from '../topics/boundary.ts'

// What a turn may do (ADR 0115): its power. Who sent each input decides it, never where it is: a person their role's
// power (`ROLE_POWER`), an OAuth client its person's role and its grant together, an installed app its grant, and work
// no one sent (a Source, a routine, the system, the agent's own reports) an admin's. It is recorded with each input's
// receipt at admission, and a run's power is the intersection over the inputs it took. Where the turn works then bounds
// it: the Persona's or Topic's setup, the boundary, and a credential's connections. Everything here is pure.

/** What a credential's grant gives a turn: its level and extras, and whether its Topics and connections are lists. */
export type GrantPower = Pick<Credential, 'grantId' | 'level' | 'extras'> & {
  readonly topics: 'all' | 'list'
  readonly connections: 'all' | 'list'
}

/** Who sent an input, as its admission saw it. */
export type Sender =
  | { readonly kind: 'person'; readonly role: WorkspaceRole }
  | { readonly kind: 'client'; readonly role: WorkspaceRole; readonly grant: GrantPower }
  | { readonly kind: 'app'; readonly grant: GrantPower }
  | { readonly kind: 'automation' }

/**
 * What a turn's senders may do: the least level and the extras all of them hold; `server` when an installed app sent
 * any input (its work is a server's, ADR 0087, and never reads the Shared folder or apps outside the hub); the grants
 * whose Topics are a list (in a hub such a turn reaches no further than its own Topic) and whose connections are a list
 * (an MCP connection must be in each).
 */
export const TurnPower = Schema.Struct({
  level: Level,
  extras: Schema.Array(Extra),
  server: Schema.Boolean,
  topicLists: Schema.Array(Schema.String),
  connectionLists: Schema.Array(Schema.String),
})
export type TurnPower = typeof TurnPower.Type

const lists = (grant: GrantPower) => ({
  topicLists: grant.topics === 'list' ? [grant.grantId] : [],
  connectionLists: grant.connections === 'list' ? [grant.grantId] : [],
})

const lower = (one: Level, other: Level): Level => (levelAtLeast(GRANT_SPEC, one, other) ? other : one)

/** The power of one sender. */
export const senderPower = (sender: Sender): TurnPower => {
  switch (sender.kind) {
    case 'person':
      return { ...ROLE_POWER[sender.role], server: false, topicLists: [], connectionLists: [] }
    case 'client': {
      const role = ROLE_POWER[sender.role]
      return {
        level: lower(role.level, sender.grant.level),
        extras: role.extras.filter((extra) => sender.grant.extras.includes(extra)),
        server: false,
        ...lists(sender.grant),
      }
    }
    case 'app':
      return { level: sender.grant.level, extras: sender.grant.extras, server: true, ...lists(sender.grant) }
    case 'automation':
      return { ...ROLE_POWER.admin, server: false, topicLists: [], connectionLists: [] }
  }
}

/** Work no person or credential sent: an admin's. */
export const AUTOMATION: TurnPower = senderPower({ kind: 'automation' })

/** What two sets of inputs may do together: each holds only what both hold. */
export const intersect = (one: TurnPower, other: TurnPower): TurnPower => ({
  level: lower(one.level, other.level),
  extras: one.extras.filter((extra) => other.extras.includes(extra)),
  server: one.server || other.server,
  topicLists: [...new Set([...one.topicLists, ...other.topicLists])],
  connectionLists: [...new Set([...one.connectionLists, ...other.connectionLists])],
})

/** The power of a run whose inputs had `powers`; a run with none is automation's. */
export const powerOfAll = (powers: readonly TurnPower[]): TurnPower => powers.reduce(intersect, AUTOMATION)

/** The sender of a request: its credential, the person a client acts for, or a member's session. */
/** What a forwarded credential's grant gives a turn. */
const grantOf = (credential: Credential): GrantPower => ({
  grantId: credential.grantId,
  level: credential.level,
  extras: credential.extras,
  topics: credential.ws.topics,
  connections: credential.ws.connections,
})

export const senderOf = (facts: {
  readonly credential?: Credential | undefined
  readonly member?: { readonly role: WorkspaceRole } | undefined
}): Sender | undefined => {
  const { credential, member } = facts
  const grant = grantOf
  // An installed app's work is a server's (ADR 0118).
  if (credential?.kind === 'app') return { kind: 'app', grant: grant(credential) }
  // A client acts for a person; one forwarded without them holds no more than a member would.
  if (credential?.kind === 'client') return { kind: 'client', role: member?.role ?? 'member', grant: grant(credential) }
  return member === undefined ? undefined : { kind: 'person', role: member.role }
}

const decodePower = Schema.decodeUnknownOption(Schema.fromJsonString(TurnPower))
const encodePower = Schema.encodeSync(Schema.fromJsonString(TurnPower))

/** A power as a receipt stores it. */
export const storedPower = (power: TurnPower): string => encodePower(power)

/** The origins of goblin's own work, which a receipt without a stored power reads as an admin's. */
const OWN_ORIGINS: ReadonlySet<string> = new Set(['owner', 'source', 'agent', 'routine', 'system'])

/**
 * A receipt's power: as stored, or for one stored before powers were (or that does not decode) as its origin and role
 * say, failing closed: a client's a member's, a person's as their role, goblin's own work (the owner's, a Source's, a
 * routine's, the agent's or the system's) an admin's, and any other origin, an app's among them, reads only.
 */
export const receiptPower = (row: {
  readonly power: string | null
  readonly origin?: string | null | undefined
  readonly role?: WorkspaceRole | null | undefined
}): TurnPower => {
  const stored = row.power === null ? Option.none() : decodePower(row.power)
  if (Option.isSome(stored)) return stored.value
  if (row.origin === 'client') return senderPower({ kind: 'person', role: 'member' })
  if (row.role !== null && row.role !== undefined) return senderPower({ kind: 'person', role: row.role })
  if (row.origin === null || row.origin === undefined || OWN_ORIGINS.has(row.origin)) return AUTOMATION
  return { level: 'read', extras: [], server: true, topicLists: [], connectionLists: [] }
}

/**
 * What a turn may use where it works: whether its setup (the Persona's or Topic's, `rootBound`, decision 9) lets it
 * start subagents. Which servers, skills and apps the setup holds each tool asks the chat's scope itself.
 */
export type Bound = { readonly subagents: () => boolean }

/**
 * A turn's power where it works (ADR 0115): its senders' power bounded by the setup there and the boundary. `hub` is
 * whether it reaches every Topic: a hub's, unless a credential whose Topics are a list sent an input; `people` whether
 * a person's turn it is (no installed app sent any input), which the Shared folder and apps outside the hub need; an
 * MCP connection is within its power when every credential with a list of connections lists it (`listed` reads a
 * grant's list, `grants/mirror.ts`), as well as the setup holding it.
 */
export type Effective = {
  readonly level: Level
  readonly extras: readonly Extra[]
  readonly topic: number
  readonly hub: boolean
  readonly people: boolean
  readonly subagents: boolean
  readonly connection: (connectionId: string) => boolean
}

export const effectivePower = (
  power: TurnPower,
  bound: Bound,
  boundary: Boundary,
  listed: (grantId: string, connectionId: string) => boolean,
): Effective => ({
  level: power.level,
  extras: power.extras,
  topic: boundary.topic,
  hub: boundary.hub && power.topicLists.length === 0,
  people: !power.server,
  subagents: bound.subagents(),
  connection: (connectionId) => power.connectionLists.every((grant) => listed(grant, connectionId)),
})

/** The boundary a turn reaches in: a hub's only when its power reaches every Topic (`Effective.hub`). */
export const turnBoundary = (effective: Effective): Boundary => ({ topic: effective.topic, hub: effective.hub })

/**
 * What a tool needs of a turn (`pi/power.ts` `TOOL_NEEDS`): a level, maybe an extra; `hub` when it acts on the whole
 * workspace (a hub's turn only); `people` when it reads what is the workspace's (a person's turn, or a hub's).
 */
export type ToolNeed = {
  readonly level: Level
  readonly extra?: Extra
  readonly hub?: true
  readonly people?: true
}

/** Whether a turn with `effective` power may use a tool that needs `need`. */
export const allows = (effective: Effective, need: ToolNeed): boolean =>
  levelAtLeast(GRANT_SPEC, effective.level, need.level) &&
  (need.extra === undefined || effective.extras.includes(need.extra)) &&
  (need.hub !== true || effective.hub) &&
  (need.people !== true || effective.people || effective.hub)
