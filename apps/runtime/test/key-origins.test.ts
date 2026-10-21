import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { RequestContext } from '../src/http/api/context.ts'
import type { Caller } from '../src/http/api/principal.ts'
import { confineThreadServer } from '../src/keys/policy.ts'

const KEY: Caller = {
  kind: 'key',
  keyId: 'key-1',
  scopes: ['conversations'],
  servers: [],
  origins: [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit', 'job_status'] }],
}
const CLIENT: Caller = { kind: 'client', clientId: 'claude', name: 'Claude Code', scopes: ['agent', 'conversations'] }

/** `confineThreadServer` in a request `caller` sent. */
const confined = (caller: Caller, url: string, tools?: readonly string[]) =>
  confineThreadServer(url, tools).pipe(
    Effect.provideService(RequestContext, {
      ref: undefined,
      request: undefined,
      operation: undefined,
      route: 'conversations.startThread',
      caller,
    }),
  )
const refusal = (caller: Caller, url: string, tools?: readonly string[]) =>
  Effect.runPromise(Effect.map(Effect.flip(confined(caller, url, tools)), (error) => error.reason))

describe("a thread's MCP server within its key's origins (ADR 0091)", () => {
  it("takes a server on a granted origin, with the tools it names or the origin's whole list", async () => {
    expect(await Effect.runPromise(confined(KEY, 'https://mcp.swarmm.app/mcp/job/42', ['job_status']))).toEqual({
      origin: 'https://mcp.swarmm.app',
      tools: ['job_status'],
    })
    expect(await Effect.runPromise(confined(KEY, 'https://MCP.swarmm.app/mcp'))).toEqual({
      origin: 'https://mcp.swarmm.app',
      tools: ['job_submit', 'job_status'],
    })
  })

  it('refuses another origin, a tool off its list, and any caller but a key', async () => {
    expect(await refusal(KEY, 'https://evil.example/mcp')).toBe('key_origin')
    expect(await refusal(KEY, 'http://mcp.swarmm.app/mcp')).toBe('key_origin')
    expect(await refusal(KEY, 'https://mcp.swarmm.app/mcp', ['job_submit', 'job_delete'])).toBe('key_origin_tool')
    expect(await refusal(CLIENT, 'https://mcp.swarmm.app/mcp')).toBe('key_only')
  })
})
