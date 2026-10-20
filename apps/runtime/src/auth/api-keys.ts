import { type ApiKeyView, type CreateApiKey, type CreatedApiKey, KeyScope, KeyServer } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { RuntimeEnv } from '../env.ts'
import { Unauthenticated } from '../http/errors.ts'
import type { KeyGrant } from '../http/api/principal.ts'
import { createAuth } from './options.ts'

/**
 * Server API keys (ADR 0081), on Better Auth's apiKey() plugin in the auth D1, read and written through Better Auth's
 * own adapter. A key's permissions are its scopes (`{ goblin: [...] }`) and its metadata its server ceiling
 * (`{ servers: [...] }`); neither is ever taken from a request.
 */

const DAY_SECONDS = 86_400
const MODEL = 'apikey'

/** A server the edge admitted by its key: the user who made the key, and what the key may reach. */
export interface KeyPrincipal extends KeyGrant {
  readonly userId: string
}

const Permissions = Schema.Struct({ goblin: Schema.Array(KeyScope) })
const Metadata = Schema.Struct({ servers: Schema.Array(KeyServer) })
/** The plugin hands permissions back parsed from some calls and as their JSON text from the adapter. */
const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    // expected: a column that is not JSON decodes to no scopes or servers.
    return null
  }
}
const scopesOf = (permissions: unknown): readonly KeyScope[] =>
  Option.match(Schema.decodeUnknownOption(Permissions)(json(permissions)), {
    onNone: () => [],
    onSome: (decoded) => decoded.goblin,
  })
const serversOf = (metadata: unknown): readonly string[] =>
  Option.match(Schema.decodeUnknownOption(Metadata)(json(metadata)), {
    onNone: () => [],
    onSome: (decoded) => decoded.servers,
  })

/**
 * The principal a key admits: valid, unexpired, within its rate limit, and made by a user who still exists. Anything
 * else is `Unauthenticated` (`key`, or `key_rate_limited`), saying nothing more.
 */
export const verifyKey = async (env: RuntimeEnv, key: string): Promise<KeyPrincipal> => {
  const auth = createAuth(env, env.AUTH_DB)
  const result = await auth.api.verifyApiKey({ body: { key } })
  if (!result.valid || result.key === null)
    throw new Unauthenticated({ reason: result.error?.code === 'RATE_LIMITED' ? 'key_rate_limited' : 'key' })
  const userId = result.key.referenceId
  if ((await (await auth.$context).internalAdapter.findUserById(userId)) === null)
    throw new Unauthenticated({ reason: 'key' })
  return {
    userId,
    keyId: result.key.id,
    scopes: scopesOf(result.key.permissions),
    servers: serversOf(result.key.metadata),
  }
}

/** A key as the plugin stores it, the columns the owner's view shows. */
interface KeyRecord {
  readonly id: string
  readonly name: string | null
  readonly start: string | null
  readonly permissions?: unknown
  readonly metadata?: unknown
  readonly createdAt: Date
  readonly expiresAt: Date | null
  readonly lastRequest: Date | null
}

const viewOf = (key: KeyRecord): ApiKeyView => ({
  id: key.id,
  name: key.name ?? '',
  ...(key.start === null ? {} : { start: key.start }),
  scopes: scopesOf(key.permissions),
  servers: serversOf(key.metadata),
  createdAt: new Date(key.createdAt).toISOString(),
  ...(key.expiresAt === null ? {} : { expiresAt: new Date(key.expiresAt).toISOString() }),
  ...(key.lastRequest === null ? {} : { lastUsedAt: new Date(key.lastRequest).toISOString() }),
})

/** The user's keys, newest first, without secrets. */
export const listKeys = async (env: RuntimeEnv, userId: string): Promise<readonly ApiKeyView[]> => {
  const { adapter } = await createAuth(env, env.AUTH_DB).$context
  const keys = await adapter.findMany<KeyRecord>({
    model: MODEL,
    where: [{ field: 'referenceId', value: userId }],
    sortBy: { field: 'createdAt', direction: 'desc' },
  })
  return keys.map(viewOf)
}

/** A new key for the user, with its secret, which is answered this once and never stored in the clear. */
export const createKey = async (env: RuntimeEnv, userId: string, input: CreateApiKey): Promise<CreatedApiKey> => {
  const created = await createAuth(env, env.AUTH_DB).api.createApiKey({
    body: {
      userId,
      name: input.name,
      expiresIn: input.expiresInDays * DAY_SECONDS,
      permissions: { goblin: [...new Set(input.scopes)] },
      metadata: { servers: [...new Set(input.servers)] },
    },
  })
  return { key: viewOf(created), secret: created.key }
}

/** Ends one of the user's keys at once; a key of another user's, or one already gone, is left as it is. */
export const revokeKey = async (env: RuntimeEnv, userId: string, keyId: string): Promise<void> => {
  const { adapter } = await createAuth(env, env.AUTH_DB).$context
  await adapter.deleteMany({
    model: MODEL,
    where: [
      { field: 'id', value: keyId },
      { field: 'referenceId', value: userId },
    ],
  })
}
