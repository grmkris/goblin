import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { confineThreadServer } from '../src/grants/policy.ts'
import { RequestContext } from '../src/http/api/context.ts'
import type { Credential } from '../src/http/api/principal.ts'
import { credential } from './grants-fixture.ts'

const ORIGINS = [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit', 'job_status'] }]
const KEY = credential({ id: 'key-1', name: 'swarmm', origins: ORIGINS })
const CLIENT = credential({ kind: 'client', id: 'claude', name: 'Claude Code', grantId: 'cg_1', origins: ORIGINS })

/** `confineThreadServer` in a request `forwarded` sent, or a member's session for none. */
const confined = (forwarded: Credential | undefined, url: string, tools?: readonly string[]) =>
  confineThreadServer(url, tools).pipe(
    Effect.provideService(RequestContext, {
      ref: undefined,
      request: undefined,
      operation: undefined,
      route: 'conversations.startThread',
      ...(forwarded === undefined ? {} : { credential: forwarded }),
    }),
  )
const refusal = (forwarded: Credential | undefined, url: string, tools?: readonly string[]) =>
  Effect.runPromise(Effect.map(Effect.flip(confined(forwarded, url, tools)), (error) => error.reason))

describe("a thread's MCP server within its grant's origins (ADRs 0091, 0114)", () => {
  it("takes a server on a granted origin, with the tools it names or the origin's whole list, for either kind", async () => {
    for (const forwarded of [KEY, CLIENT]) {
      expect(await Effect.runPromise(confined(forwarded, 'https://mcp.swarmm.app/mcp/job/42', ['job_status']))).toEqual(
        { origin: 'https://mcp.swarmm.app', tools: ['job_status'] },
      )
      expect(await Effect.runPromise(confined(forwarded, 'https://MCP.swarmm.app/mcp'))).toEqual({
        origin: 'https://mcp.swarmm.app',
        tools: ['job_submit', 'job_status'],
      })
    }
  })

  it('refuses another origin, a tool off its list, and a request that is no credential', async () => {
    expect(await refusal(KEY, 'https://evil.example/mcp')).toBe('key_origin')
    expect(await refusal(KEY, 'http://mcp.swarmm.app/mcp')).toBe('key_origin')
    expect(await refusal(KEY, 'https://mcp.swarmm.app/mcp', ['job_submit', 'job_delete'])).toBe('key_origin_tool')
    expect(await refusal(credential({ kind: 'client', grantId: 'cg_2' }), 'https://mcp.swarmm.app/mcp')).toBe(
      'key_origin',
    )
    expect(await refusal(undefined, 'https://mcp.swarmm.app/mcp')).toBe('credential_only')
  })
})
