import type { KeyOrigin } from '@goblin/contracts'
import { listKeys } from '../auth/api-keys.ts'
import type { RuntimeEnv } from '../env.ts'

/**
 * The origins key `keyId` of workspace `workspaceId` grants now (ADR 0091), read from the auth store; none once the key
 * is gone or past its expiry. A thread's declared servers are checked against it at every use (ADR 0103).
 */
export async function keyOriginsNow(
  env: RuntimeEnv,
  workspaceId: string,
  keyId: string,
): Promise<readonly KeyOrigin[] | undefined> {
  const key = (await listKeys(env, workspaceId)).find((each) => each.id === keyId)
  if (key === undefined) return undefined
  if (key.expiresAt !== undefined && Date.parse(key.expiresAt) <= Date.now()) return undefined
  return key.origins
}
