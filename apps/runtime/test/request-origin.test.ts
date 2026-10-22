import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { RequestContext } from '../src/http/api/context.ts'
import type { Caller } from '../src/http/api/principal.ts'
import { requestAuthor, requestFlowOrigin } from '../src/keys/policy.ts'

const CLIENT: Caller = { kind: 'client', clientId: 'claude', name: 'Claude Code', scopes: ['conversations'] }
const KEY: Caller = {
  kind: 'key',
  keyId: 'key-1',
  name: 'swarmm-prod',
  scopes: ['conversations'],
  servers: [],
  origins: [],
}

/** What `read` says of a request `caller` sent, or a member's own when none. */
const inRequest = <A>(read: Effect.Effect<A>, caller?: Caller) =>
  Effect.runPromise(
    read.pipe(
      Effect.provideService(RequestContext, {
        ref: undefined,
        request: undefined,
        operation: undefined,
        route: 'conversations.submit',
        ...(caller === undefined ? {} : { caller }),
      }),
    ),
  )

/** The flow origin of a request `caller` sent, or a member's own when none. */
const originOf = (caller?: Caller) => inRequest(requestFlowOrigin, caller)

describe("where a request's flow comes from (ADR 0037)", () => {
  it("records a caller's send as an MCP client's, and anyone else's as the owner's in the app", async () => {
    expect(await originOf(CLIENT)).toEqual({ via: 'mcp', actor: 'client' })
    expect(await originOf()).toEqual({ via: 'app', actor: 'owner' })
    expect(await Effect.runPromise(requestFlowOrigin)).toEqual({ via: 'app', actor: 'owner' })
  })
})

describe("who a request's message is by (ADR 0108)", () => {
  it("names a server's key as a server by its name, a client by its own, and the owner's session by none", async () => {
    expect(await inRequest(requestAuthor, KEY)).toBe('server swarmm-prod')
    expect(await inRequest(requestAuthor, CLIENT)).toBe('Claude Code')
    expect(await inRequest(requestAuthor)).toBeUndefined()
  })
})
