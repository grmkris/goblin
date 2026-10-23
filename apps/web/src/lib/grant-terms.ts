import {
  type Extra,
  type GrantTerms,
  type KeyOrigin,
  type Level,
  type Lifetime,
  type WorkspaceReach,
  presetFor,
} from '@goblin/contracts'

// The key form's and the consent page's switches as a grant's terms (ADR 0114), until the grant editor replaces them:
// what they offered before as scopes, now a level and extras over the workspace's Topics, Personas and connections.

/** What the key form offers: making Topics and Personas, sending, and reading how chats ran. */
export type KeyPower = 'topics' | 'conversations' | 'personas' | 'inspect'

/** A grant's level for `powers`: manage to make Topics or Personas, write to send, else read. */
const levelOf = (powers: readonly KeyPower[]): Level =>
  powers.includes('topics') || powers.includes('personas')
    ? 'manage'
    : powers.includes('conversations')
      ? 'write'
      : 'read'

/** The powers a grant's terms hold, as the key form's switches show them. */
export const powersOf = (terms: GrantTerms): readonly KeyPower[] => [
  ...(terms.level === 'manage' ? (['topics', 'conversations', 'personas'] as const) : []),
  ...(terms.level === 'write' ? (['conversations'] as const) : []),
  ...(terms.extras.includes('inspect') ? (['inspect'] as const) : []),
]

/** The lifetime that lasts at least `days`, a year at most. */
export const lifetimeOf = (days: number): Lifetime =>
  days <= 1 ? '1d' : days <= 7 ? '7d' : days <= 30 ? '30d' : days <= 90 ? '90d' : '365d'

/** `terms` with the level and `inspect` that `powers` say, its other extras kept. */
export const withPowers = (terms: GrantTerms, powers: readonly KeyPower[]): GrantTerms => {
  const others: readonly Extra[] = terms.extras.filter((extra) => extra !== 'inspect')
  return {
    ...terms,
    level: levelOf(powers),
    extras: powers.includes('inspect') ? [...others, 'inspect'] : others,
  }
}

/** `terms` with `origins` as the MCP servers its threads may connect to (ADR 0091). */
export const withOrigins = (terms: GrantTerms, origins: readonly KeyOrigin[]): GrantTerms => ({
  ...terms,
  reach: { ...terms.reach, origins },
})

/**
 * A new key's terms in workspace `workspace`: every Topic and Persona, the connections it names (every one when it
 * names none), the setup extra when it may make Topics and names servers, its origins and lifetime.
 */
export const keyTermsFrom = (key: {
  readonly name: string
  readonly workspace: string
  readonly powers: readonly KeyPower[]
  readonly servers: readonly string[]
  readonly origins: readonly KeyOrigin[]
  readonly days: number
}): GrantTerms => {
  const preset = presetFor(key.name, [key.workspace])
  const each: WorkspaceReach = {
    workspace: key.workspace,
    topics: { kind: 'all' },
    personas: { kind: 'all' },
    connections: key.servers.length === 0 ? { kind: 'all' } : { kind: 'list', ids: [...key.servers] },
  }
  const setup: readonly Extra[] = key.powers.includes('topics') && key.servers.length > 0 ? ['setup'] : []
  const terms = withPowers({ ...preset, extras: setup }, key.powers)
  return {
    ...terms,
    reach: { workspaces: 'list', each: [each], origins: key.origins },
    lifetime: lifetimeOf(key.days),
  }
}

/** Which of the person's workspaces a client reaches: all of them, or those listed. */
export interface ReachChoice {
  readonly all: boolean
  readonly workspaces: readonly string[]
}

/** `terms` reaching `choice`'s workspaces, each with what `terms` held there before (everything when it held none). */
export const withWorkspaces = (terms: GrantTerms, choice: ReachChoice): GrantTerms => ({
  ...terms,
  reach: {
    ...terms.reach,
    workspaces: choice.all ? 'all' : 'list',
    each: choice.all
      ? terms.reach.each
      : choice.workspaces.map(
          (workspace) =>
            terms.reach.each.find((each) => each.workspace === workspace) ?? {
              workspace,
              topics: { kind: 'all' },
              personas: { kind: 'all' },
              connections: { kind: 'all' },
            },
        ),
  },
})

/** A new client's terms on the consent page: the preset (`write`, everything, until revoked) over `choice`. */
export const clientTermsFrom = (name: string, choice: ReachChoice): GrantTerms =>
  withWorkspaces(presetFor(name, 'all'), choice)
