import type { RuntimeEnv } from '../env.ts'
import { unwrap } from '../http/rpc.ts'

/**
 * Erase a workspace's agent before its records go (ADR 0089). `Agent.destroy()` aborts the agent's isolate right after
 * wiping storage, so the RPC can fail with that abort even though the wipe finished; only that failure is tolerated.
 * Any other failure aborts the deletion, leaving it to retry.
 */
export const deleteAgentOf = async (
  env: { readonly AGENTS: Pick<RuntimeEnv['AGENTS'], 'getByName'> },
  workspaceId: string,
): Promise<void> => {
  try {
    unwrap(await env.AGENTS.getByName(workspaceId).deleteAgentData())
  } catch (cause) {
    if (!(cause instanceof Error) || !/destroyed/u.test(cause.message)) throw cause
  }
}
