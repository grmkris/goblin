import { GRANT_SPEC, type Extra, type Level, type ReachKind, missingFor, reachId } from '@goblin/contracts'
import { NotFound, accessInsufficient } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type GrantSource, Grants } from '../src/grants/service.ts'
import type { Mirrored, MirrorItem } from '../src/grants/mirror.ts'
import type { Credential } from '../src/http/api/principal.ts'

/** The app URL the fixtures' widening links name. */
export const FIXTURE_APP = 'https://goblin.test'

/** The workspace the fixtures' agent belongs to. */
export const FIXTURE_WORKSPACE = 'w1'

type Coverage = 'all' | 'list'

/** A credential as the Worker forwards it, from what a test cares about; the rest every Topic, Persona and connection. */
export const credential = (parts: {
  readonly kind?: Credential['kind']
  readonly id?: string
  readonly name?: string
  readonly grantId?: string
  readonly level?: Level
  readonly extras?: readonly Extra[]
  readonly topics?: Coverage
  readonly personas?: Coverage
  readonly connections?: Coverage
  readonly generation?: number
  readonly origins?: Credential['origins']
  readonly expiresAt?: number | null
}): Credential => ({
  kind: parts.kind ?? 'key',
  id: parts.id ?? 'key-1',
  name: parts.name ?? parts.id ?? 'key-1',
  grantId: parts.grantId ?? parts.id ?? 'key-1',
  level: parts.level ?? 'write',
  extras: parts.extras ?? [],
  expiresAt: parts.expiresAt ?? null,
  ws: {
    workspace: FIXTURE_WORKSPACE,
    topics: parts.topics ?? 'all',
    personas: parts.personas ?? 'all',
    connections: parts.connections ?? 'all',
    generation: parts.generation ?? 1,
  },
  origins: parts.origins ?? [],
})

/** The header that forwards `forwarded`, as the edge and /mcp send it. */
export const credentialHeaders = (forwarded: Credential): Record<string, string> => ({
  'x-goblin-caller': JSON.stringify(forwarded),
})

const FIELD = { topic: 'topics', persona: 'personas', connection: 'connections' } as const satisfies Record<
  ReachKind,
  keyof Credential['ws']
>

/**
 * Grants where nothing is listed: a credential reaches what its coverage says is all, and nothing of a list; its level
 * and extras are checked as the agent checks them. What a test that lists nothing serves with.
 */
export const idleGrants = Layer.succeed(
  Grants,
  Grants.of({
    sync: () => Effect.void,
    reaches: (held, item) => Effect.succeed(held.ws[FIELD[item.kind]] === 'all'),
    append: () => Effect.void,
    require: (held, need) => {
      const lacking = missingFor(GRANT_SPEC, held, {
        ...(need.level === undefined ? {} : { level: need.level }),
        ...(need.extra === undefined ? {} : { extra: need.extra }),
      })
      const item = need.reach
      const outside = item !== undefined && held.ws[FIELD[item.kind]] !== 'all'
      const missing = {
        ...lacking,
        ...(outside ? { reachId: reachId(held.ws.workspace, item.kind, item.id) } : {}),
      }
      return Object.keys(missing).length === 0
        ? Effect.void
        : Effect.fail(accessInsufficient(FIXTURE_APP, held.grantId, missing))
    },
    summary: () => Effect.fail(new NotFound({ what: 'grant' })),
  }),
)

/**
 * An auth store held in memory for the agent's `Grants` (`GrantSource`): each grant's coverage of the fixture's
 * workspace and its listed ids, which a test sets and reads back.
 */
export const memoryGrants = () => {
  const held = new Map<string, { coverage: Mirrored; items: MirrorItem[] }>()
  const source: GrantSource = {
    reach: (grantId) => {
      const found = held.get(grantId)
      return Promise.resolve(
        found === undefined
          ? { coverage: undefined, items: [] }
          : { coverage: found.coverage, items: [...found.items] },
      )
    },
    append: (grantId, item) => {
      const found = held.get(grantId)
      const field = FIELD[item.kind]
      if (
        found !== undefined &&
        found.coverage[field] === 'list' &&
        !found.items.some((each) => each.kind === item.kind && each.id === item.id)
      ) {
        found.items.push(item)
        found.coverage = { ...found.coverage, generation: found.coverage.generation + 1 }
      }
      return Promise.resolve()
    },
    summary: () => Promise.resolve(undefined),
  }
  return {
    source,
    /** Grant `grantId` as `forwarded` covers it, listing `items`. */
    set: (forwarded: Credential, items: readonly MirrorItem[] = []) =>
      void held.set(forwarded.grantId, {
        coverage: {
          generation: forwarded.ws.generation,
          topics: forwarded.ws.topics,
          personas: forwarded.ws.personas,
          connections: forwarded.ws.connections,
        },
        items: [...items],
      }),
    /** The ids grant `grantId` lists of `kind` now. */
    listed: (grantId: string, kind: ReachKind): readonly string[] =>
      (held.get(grantId)?.items ?? []).filter((item) => item.kind === kind).map((item) => item.id),
    layer: Grants.layerWith(source, FIXTURE_APP),
  }
}
