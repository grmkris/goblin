import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { RequestContext } from '../src/http/api/context.ts'
import type { Credential } from '../src/http/api/principal.ts'
import { requestAuthor, requestFlowOrigin } from '../src/grants/policy.ts'
import { credential } from './grants-fixture.ts'

const CLIENT = credential({ kind: 'client', id: 'claude', name: 'Claude Code', grantId: 'cg_1' })
const KEY = credential({ id: 'key-1', name: 'swarmm-prod' })

/** What `read` says of a request `caller` sent, or a member's own when none. */
const inRequest = <A>(read: Effect.Effect<A>, caller?: Credential) =>
  Effect.runPromise(
    read.pipe(
      Effect.provideService(RequestContext, {
        ref: undefined,
        request: undefined,
        operation: undefined,
        route: 'conversations.submit',
        ...(caller === undefined ? {} : { credential: caller }),
      }),
    ),
  )

/** The flow origin of a request `caller` sent, or a member's own when none. */
const originOf = (caller?: Credential) => inRequest(requestFlowOrigin, caller)

describe("where a request's flow comes from (ADR 0037)", () => {
  it("records a caller's send as an MCP client's, and anyone else's as the owner's in the app", async () => {
    expect(await originOf(CLIENT)).toEqual({ via: 'mcp', actor: 'client' })
    expect(await originOf()).toEqual({ via: 'app', actor: 'owner' })
    expect(await Effect.runPromise(requestFlowOrigin)).toEqual({ via: 'app', actor: 'owner' })
  })
})

describe("who a request's message is by (ADR 0115)", () => {
  it("names a server's key as a server by its name, a client by its own, and the owner's session by none", async () => {
    expect(await inRequest(requestAuthor, KEY)).toBe('server swarmm-prod')
    expect(await inRequest(requestAuthor, CLIENT)).toBe('Claude Code')
    expect(await inRequest(requestAuthor)).toBeUndefined()
  })
})
