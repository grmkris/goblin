import type { Extension } from '@earendil-works/pi-durable'
import { type CodemodeRemote, RemoteCodemodeSandbox } from '@earendil-works/pi-codemode/portable'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'

/**
 * The sandbox Worker's Durable Object, bound with `script_name` (alchemy.run.ts): scripts run in its isolate, so a
 * script that computes does not hold the agent's object (pi-codemode README, "Why a separate Worker").
 */
export interface CodemodeSandboxBinding {
  getByName(name: string): CodemodeRemote
}

/**
 * Durable code mode (spike): a `codemode` tool whose scripts call the agent's tools as nested calls and survive a
 * restart by deterministic replay. Tools whose `callers` is `['model']` (ask_user, mcp_call, ...) stay out of scripts.
 * One sandbox object per agent keeps an agent's scripts together and apart from the others.
 */
export function codemodeExtension(binding: CodemodeSandboxBinding, agent: () => string): Extension {
  const sandbox = new RemoteCodemodeSandbox({
    timeoutMs: 60_000,
    remote: () => binding.getByName(agent()),
  })
  return createCodemodeExtension({
    sandbox,
    namespaces: [{ name: 'mcp', description: "The owner's connected MCP servers", prefix: 'mcp_' }],
  })
}
