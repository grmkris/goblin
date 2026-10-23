import {
  type AccessSummary,
  GRANT_SPEC,
  type Missing,
  type Need,
  type ReachKind,
  missingFor,
  reachId,
} from '@goblin/contracts'
import { type AccessInsufficient, accessInsufficient } from '@goblin/contracts/api'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { appendReach, grantById, isLive, reachRows, termsOf } from '../auth/grants.ts'
import { summaryOf } from '../auth/consent-terms.ts'
import type { Credential } from '../http/api/principal.ts'
import { type AppError, NotFound, attempt, attemptSync } from '../http/errors.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { type Mirrored, type MirrorItem, appendMirror, mirrorReaches, mirrored, replaceMirror } from './mirror.ts'

/**
 * Where the agent reads a grant (ADR 0114): the auth store, for the workspace the agent belongs to. A port, so a test
 * serves its own.
 */
export interface GrantSource {
  /** Grant `grantId`'s coverage of this workspace (none when it no longer reaches it) and its listed ids here. */
  readonly reach: (
    grantId: string,
  ) => Promise<{ readonly coverage: Mirrored | undefined; readonly items: readonly MirrorItem[] }>
  /** Lists `item` in grant `grantId`'s reach of this workspace, when that reach is a list without it. */
  readonly append: (grantId: string, item: MirrorItem, now: number) => Promise<void>
  /** Grant `grantId`'s summary while it is live; none once it is gone or ended. */
  readonly summary: (grantId: string, now: number) => Promise<AccessSummary | undefined>
}

/** What a call needs of a credential's grant: a level, an extra, and one item it must reach. */
export interface Requirement extends Partial<Need> {
  readonly reach?: MirrorItem
}

const FIELD = { topic: 'topics', persona: 'personas', connection: 'connections' } as const satisfies Record<
  ReachKind,
  keyof Credential['ws']
>

/**
 * The grants of the credentials that reach this agent (ADR 0114), mirrored from the auth store: a request's credential
 * is synced at admission when its forwarded generation is not the mirror's, so every check after it reads the mirror.
 *
 * - `sync`: reads the credential's grant again when the mirror holds another generation, or none.
 * - `reaches`: whether it reaches one Topic, Persona or connection: all of its kind, or listed.
 * - `append`: lists what it just made, in the auth store and the mirror, when its reach of that kind is a list.
 * - `require`: what a call needs of it (level, extra, one item), else `AccessInsufficient` with the widening link.
 * - `summary`: its grant as `GET /api/access` answers it.
 */
export class Grants extends Context.Service<
  Grants,
  {
    readonly sync: (credential: Credential) => Effect.Effect<void, AppError>
    readonly reaches: (credential: Credential, item: MirrorItem) => Effect.Effect<boolean, AppError>
    readonly append: (credential: Credential, item: MirrorItem) => Effect.Effect<void, AppError>
    readonly require: (credential: Credential, need: Requirement) => Effect.Effect<void, AccessInsufficient | AppError>
    readonly summary: (credential: Credential) => Effect.Effect<AccessSummary, AppError>
  }
>()('goblin/grants/Grants') {
  /** Grants over `source`, refusing with widening links under `appUrl` (the deployment's own URL). */
  static layerWith(source: GrantSource, appUrl: string) {
    return Layer.effect(
      Grants,
      Effect.gen(function* () {
        const db = yield* Db
        const sync = Effect.fn('Grants.sync')(function* (credential: Credential) {
          const held = yield* attemptSync(() => mirrored(db, credential.grantId))
          if (held?.generation === credential.ws.generation) return
          const read = yield* attempt(() => source.reach(credential.grantId))
          const now = yield* Clock.currentTimeMillis
          yield* attemptSync(() => replaceMirror(db, credential.grantId, read, now))
        })
        const reaches = Effect.fn('Grants.reaches')(function* (credential: Credential, item: MirrorItem) {
          if (credential.ws[FIELD[item.kind]] === 'all') return true
          return yield* attemptSync(() => mirrorReaches(db, credential.grantId, item.kind, item.id))
        })
        const append = Effect.fn('Grants.append')(function* (credential: Credential, item: MirrorItem) {
          if (credential.ws[FIELD[item.kind]] === 'all') return
          const now = yield* Clock.currentTimeMillis
          // The mirror first: the request's own later checks see it even if the auth store's write fails, and a replay
          // of the create puts that right (`claim`).
          yield* attemptSync(() => appendMirror(db, credential.grantId, item))
          yield* attempt(() => source.append(credential.grantId, item, now))
        })
        const require = Effect.fn('Grants.require')(function* (credential: Credential, need: Requirement) {
          const lacking = missingFor(GRANT_SPEC, credential, {
            ...(need.level === undefined ? {} : { level: need.level }),
            ...(need.extra === undefined ? {} : { extra: need.extra }),
          })
          const item = need.reach
          const outside = item !== undefined && !(yield* reaches(credential, item))
          const missing: Missing = {
            ...lacking,
            ...(outside ? { reachId: reachId(credential.ws.workspace, item.kind, item.id) } : {}),
          }
          if (Object.keys(missing).length > 0) return yield* accessInsufficient(appUrl, credential.grantId, missing)
        })
        const summary = Effect.fn('Grants.summary')(function* (credential: Credential) {
          const now = yield* Clock.currentTimeMillis
          const found = yield* attempt(() => source.summary(credential.grantId, now))
          if (found === undefined) return yield* new NotFound({ what: 'grant' })
          return found
        })
        return Grants.of({ sync, reaches, append, require, summary })
      }),
    )
  }

  /** Grants over the deployment's auth store, for this agent's workspace. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { env, workspaceId } = yield* AgentInput
      const db = env.AUTH_DB
      return Grants.layerWith(
        {
          reach: async (grantId) => {
            const { coverage, items } = await reachRows(db, grantId, workspaceId)
            return {
              coverage:
                coverage === undefined
                  ? undefined
                  : {
                      generation: coverage.generation,
                      topics: coverage.topics,
                      personas: coverage.personas,
                      connections: coverage.connections,
                    },
              items,
            }
          },
          append: (grantId, item, now) => appendReach(db, grantId, workspaceId, item, now),
          summary: async (grantId, now) => {
            const grant = await grantById(db, grantId)
            if (grant === undefined || !isLive(grant, now)) return undefined
            return summaryOf(env.APP_URL, grant, await termsOf(db, grant))
          },
        },
        env.APP_URL,
      )
    }),
  )
}
