import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { RequestContext } from '../src/http/api/context.ts'
import type { Caller } from '../src/http/api/principal.ts'
import { requestFlowOrigin } from '../src/keys/policy.ts'

const CLIENT: Caller = { kind: 'client', clientId: 'claude', name: 'Claude Code', scopes: ['conversations'] }

/** The flow origin of a request `caller` sent, or a member's own when none. */
const originOf = (caller?: Caller) =>
  Effect.runPromise(
    requestFlowOrigin.pipe(
      Effect.provideService(RequestContext, {
        ref: undefined,
        request: undefined,
        operation: undefined,
        route: 'conversations.submit',
        ...(caller === undefined ? {} : { caller }),
      }),
    ),
  )

describe("where a request's flow comes from (ADR 0037)", () => {
  it("records a caller's send as an MCP client's, and anyone else's as the owner's in the app", async () => {
    expect(await originOf(CLIENT)).toEqual({ via: 'mcp', actor: 'client' })
    expect(await originOf()).toEqual({ via: 'app', actor: 'owner' })
    expect(await Effect.runPromise(requestFlowOrigin)).toEqual({ via: 'app', actor: 'owner' })
  })
})
