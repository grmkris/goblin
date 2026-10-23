import type { ApiKeyView, CreateApiKeyTerms, CreatedApiKey, UpdateApiKeyTerms } from '@goblin/contracts'
import { API_KEY_TABLE_NAME, defaultKeyHasher } from '@better-auth/api-key'
import { generateRandomString } from 'better-auth/crypto'
import type { RuntimeEnv } from '../env.ts'
import { Conflict, NotFound, Unauthenticated } from '../http/errors.ts'
import type { Credential } from '../http/api/principal.ts'
import {
  type GrantRecord,
  coverageIn,
  createKeyGrant,
  grantOfKey,
  isLive,
  newKeyTerms,
  setTerms,
  termsOf,
} from './grants.ts'
import { createAuth } from './options.ts'
import { KEY_LENGTH, KEY_PREFIX, KEY_START_LENGTH } from './resources.ts'

/**
 * Server API keys (ADR 0081), on Better Auth's apiKey() plugin in the auth D1, read and written through Better Auth's
 * own adapter. A key belongs to a workspace (ADR 0089): its `referenceId` is the workspace's ID. What it may do is its
 * grant (ADR 0114, `grants.ts`), whose id is the key's own; the plugin keeps only its secret's hash, its name and who
 * made it (`metadata.createdBy`). None of it is ever taken from a request but a manager's.
 */

const MODEL = API_KEY_TABLE_NAME

/** A server the edge admitted by its key: the workspace the key belongs to, and the credential its grant makes. */
export interface KeyPrincipal {
  readonly workspaceId: string
  readonly credential: Credential
}

/** The credential `grant` makes in `workspaceId`, for a key or a client named `name` (`id` the key's or client's). */
export const credentialOf = (
  grant: GrantRecord,
  identity: { readonly id: string; readonly name: string },
  ws: Credential['ws'],
): Credential => ({
  kind: grant.kind,
  id: identity.id,
  name: identity.name.slice(0, 200),
  grantId: grant.id,
  level: grant.level,
  extras: grant.extras,
  expiresAt: grant.expiresAt,
  ws,
  origins: grant.origins,
})

/**
 * The principal a key admits: valid, of a workspace that still exists, with a grant that has not ended. A key that does
 * not verify, or whose workspace is gone, is `Unauthenticated` (`key`), saying nothing more; one whose grant ended is
 * `grant_expired`. Its rate limit is its agent's to count (ADR 0085).
 */
export const verifyKey = async (env: RuntimeEnv, key: string): Promise<KeyPrincipal> => {
  const auth = createAuth(env, env.AUTH_DB)
  const result = await auth.api.verifyApiKey({ body: { key } })
  if (!result.valid || result.key === null) throw new Unauthenticated({ reason: 'key' })
  const workspaceId = result.key.referenceId
  const grant = await grantOfKey(env.AUTH_DB, result.key.id)
  if (grant === undefined) throw new Unauthenticated({ reason: 'key' })
  if (!isLive(grant, Date.now())) throw new Unauthenticated({ reason: 'grant_expired' })
  const ws = await coverageIn(env.AUTH_DB, grant, workspaceId)
  const { adapter } = await auth.$context
  if (
    ws === undefined ||
    (await adapter.findOne({ model: 'organization', where: [{ field: 'id', value: workspaceId }] })) === null
  )
    throw new Unauthenticated({ reason: 'key' })
  return { workspaceId, credential: credentialOf(grant, { id: result.key.id, name: result.key.name ?? '' }, ws) }
}

/** A key as the plugin stores it, the columns the owner's view shows. */
interface KeyRecord {
  readonly id: string
  readonly name: string | null
  readonly start: string | null
  readonly createdAt: Date
  readonly lastRequest: Date | null
}

/** A key with its grant as the owner's view shows it; its end is its grant's. */
const viewOf = async (env: RuntimeEnv, key: KeyRecord): Promise<ApiKeyView> => {
  const grant = await grantOfKey(env.AUTH_DB, key.id)
  if (grant === undefined) throw new NotFound({ what: 'key' })
  return {
    id: key.id,
    name: key.name ?? '',
    ...(key.start === null ? {} : { start: key.start }),
    createdAt: new Date(key.createdAt).toISOString(),
    ...(grant.expiresAt === null ? {} : { expiresAt: new Date(grant.expiresAt).toISOString() }),
    ...(key.lastRequest === null ? {} : { lastUsedAt: new Date(key.lastRequest).toISOString() }),
    grantId: grant.id,
    terms: await termsOf(env.AUTH_DB, grant),
  }
}

/** The workspace's keys, newest first, without secrets. */
export const listKeys = async (env: RuntimeEnv, workspaceId: string): Promise<readonly ApiKeyView[]> => {
  const { adapter } = await createAuth(env, env.AUTH_DB).$context
  const keys = await adapter.findMany<KeyRecord>({
    model: MODEL,
    where: [{ field: 'referenceId', value: workspaceId }],
    sortBy: { field: 'createdAt', direction: 'desc' },
  })
  return Promise.all(keys.map((key) => viewOf(env, key)))
}

/** The workspace's key `keyId` and its grant; `NotFound` for a key of another workspace's, or one that is gone. */
const keyOf = async (env: RuntimeEnv, workspaceId: string, keyId: string) => {
  const { adapter } = await createAuth(env, env.AUTH_DB).$context
  const key = await adapter.findOne<KeyRecord & { readonly key: string }>({
    model: MODEL,
    where: [
      { field: 'id', value: keyId },
      { field: 'referenceId', value: workspaceId },
    ],
  })
  const grant = key === null ? undefined : await grantOfKey(env.AUTH_DB, keyId)
  if (key === null || grant === undefined) throw new NotFound({ what: 'key' })
  return { adapter, key, grant }
}

/**
 * A new key for the workspace, made by `userId` (an owner or admin there) with its grant's terms, and its secret, which
 * is answered this once and never stored in the clear. The plugin checks that they may make one; the grant is written
 * with the key, and a key whose grant could not be written is deleted again, so no key ever stands without one.
 */
export const createKey = async (
  env: RuntimeEnv,
  workspaceId: string,
  userId: string,
  input: CreateApiKeyTerms,
): Promise<CreatedApiKey> => {
  const now = Date.now()
  // The terms are checked as the grant they will be before the key exists: only an owner gives `keys`, origins clean.
  const terms = await newKeyTerms(env.AUTH_DB, userId, workspaceId, { ...input.terms, name: input.name })
  const auth = createAuth(env, env.AUTH_DB)
  const created = await auth.api.createApiKey({
    body: { organizationId: workspaceId, userId, name: input.name, metadata: { createdBy: userId } },
  })
  try {
    await createKeyGrant(env.AUTH_DB, { keyId: created.id, workspaceId, userId }, terms, now)
  } catch (cause) {
    const { adapter } = await auth.$context
    await adapter.deleteMany({ model: MODEL, where: [{ field: 'id', value: created.id }] })
    throw cause
  }
  return { key: await viewOf(env, created), secret: created.key }
}

/** One of the workspace's keys before and after a change. */
export interface KeyChange {
  readonly before: ApiKeyView
  readonly after: ApiKeyView
}

/**
 * New terms for one of the workspace's keys' grant, by `userId` (an owner or admin there): the same key, its id and
 * secret kept, its name the terms' (ADR 0114). A key of another workspace's, or one that is gone, is `NotFound`; origins
 * with a problem are `InvalidInput`.
 */
export const updateKey = async (
  env: RuntimeEnv,
  workspaceId: string,
  userId: string,
  keyId: string,
  change: UpdateApiKeyTerms,
): Promise<KeyChange> => {
  const { adapter, key, grant } = await keyOf(env, workspaceId, keyId)
  const before = await viewOf(env, key)
  const saved = await setTerms(env.AUTH_DB, userId, grant, change.terms, Date.now())
  const named = await adapter.update<KeyRecord>({
    model: MODEL,
    where: [{ field: 'id', value: keyId }],
    update: { name: saved.name.slice(0, 64), updatedAt: new Date() },
  })
  return { before, after: await viewOf(env, named ?? key) }
}

/**
 * A secret as the plugin makes one for a new key under our options: the prefix, then `KEY_LENGTH` letters from Better
 * Auth's own generator. The plugin keeps its default generator to itself, so this is that one, alphabet and all; the
 * tests hold a rotated secret to a made one's shape.
 */
const newSecret = (): string => `${KEY_PREFIX}${generateRandomString(KEY_LENGTH, 'a-z', 'A-Z')}`

/**
 * A new secret for one of the workspace's keys (ADR 0105), answered this once and stored only as the plugin stores
 * one, its hash and first characters. It is the same key: its id, name and grant stay, and the old secret admits
 * nothing from now on, since the row holds one hash. A key of another workspace's, or one that is gone or whose grant
 * ended, is `NotFound`; of two rotations at once, the one that finds the hash already changed is `Conflict` (`rotated`),
 * so no answer carries a secret that never worked.
 */
export const rotateKey = async (env: RuntimeEnv, workspaceId: string, keyId: string): Promise<CreatedApiKey> => {
  const { adapter, key, grant } = await keyOf(env, workspaceId, keyId)
  if (!isLive(grant, Date.now())) throw new NotFound({ what: 'key' })
  const secret = newSecret()
  // With the secret's hash, which only a rotation reads: the update matches it, or another rotation came first.
  const rotated = await adapter.update<KeyRecord>({
    model: MODEL,
    where: [
      { field: 'id', value: keyId },
      { field: 'referenceId', value: workspaceId },
      { field: 'key', value: key.key },
    ],
    update: { key: await defaultKeyHasher(secret), start: secret.slice(0, KEY_START_LENGTH), updatedAt: new Date() },
  })
  if (rotated === null) throw new Conflict({ reason: 'rotated' })
  return { key: await viewOf(env, rotated), secret }
}

/** Ends one of the workspace's keys at once, its grant with it; a key of another workspace's, or one gone, is left. */
export const revokeKey = async (env: RuntimeEnv, workspaceId: string, keyId: string): Promise<void> => {
  const { adapter } = await createAuth(env, env.AUTH_DB).$context
  await env.AUTH_DB.prepare(
    'DELETE FROM "grant" WHERE "keyId" = ? AND EXISTS (SELECT 1 FROM apikey WHERE id = ? AND referenceId = ?)',
  )
    .bind(keyId, keyId, workspaceId)
    .run()
  await adapter.deleteMany({
    model: MODEL,
    where: [
      { field: 'id', value: keyId },
      { field: 'referenceId', value: workspaceId },
    ],
  })
}
