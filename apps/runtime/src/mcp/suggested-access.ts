// Suggested access (ADR 0060): what goblin suggests for each tool a server offers, from the tool's own annotations, and
// the owner's one tap that applies it. Annotations are the server's claims: they suggest, and grant nothing until the
// owner applies them.
import type { Tool } from '@modelcontextprotocol/client'
import * as Effect from 'effect/Effect'
import { McpGrants, McpServers } from './service.ts'

/** `run` when the tool says it only reads (and does not say it destroys), else `ask`. */
export const suggestedPolicy = (tool: Tool): 'run' | 'ask' => {
  const { readOnlyHint, destructiveHint } = tool.annotations ?? {}
  return readOnlyHint === true && destructiveHint !== true ? 'run' : 'ask'
}

/**
 * "Use suggested access" on connection `connectionId`, the owner's act: every tool the agent can see is allowed, and
 * each one suggested `ask` asks first. An ask-first switch the owner already turned on stays on, and nothing else of
 * the owner's grants changes.
 */
export const allowSuggested = (connectionId: string) =>
  Effect.gen(function* () {
    const tools = yield* McpServers.use((servers) => servers.tools(connectionId, false))
    const grants = yield* McpGrants
    for (const tool of tools) {
      if (!tool.modelVisible) continue
      if (!tool.granted) yield* grants.setTool(connectionId, tool.name, true)
      if (tool.suggested === 'ask' && tool.askFirst !== true) yield* grants.setAskFirst(connectionId, tool.name, true)
    }
    return yield* grants.list()
  })
