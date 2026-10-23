import type { InspectQuery } from '@goblin/contracts/inspect'
import * as Effect from 'effect/Effect'
import type { Credential } from '../src/http/api/principal.ts'
import { type AgentFetch, type OwnerClient, ownerCall } from '../src/inbound/client.ts'
import { type RpcResult, encodeExit } from '../src/http/rpc.ts'

/**
 * The OAuth client the probes act as (ADRs 0086, 0114), named `name`, its grant `manage` over every Topic, Persona and
 * connection with `inspect`.
 */
export const fixtureClient = (name = 'fixture-client'): Credential => ({
  kind: 'client',
  id: 'fixture-client',
  name,
  grantId: 'cg_fixture',
  level: 'manage',
  extras: ['inspect'],
  expiresAt: null,
  ws: { workspace: 'probe', topics: 'all', personas: 'all', connections: 'all', generation: 1 },
  origins: [],
})

/** The person an OAuth client of the probes acts for (ADR 0089). */
const PROBE_MEMBER = { user: 'probe-owner', role: 'owner', name: 'Owner', shared: false } as const

/**
 * One owner API call as `caller`, as /mcp makes it, answered in the shape the probes assert on: `{ ok: true, value }`,
 * or `{ ok: false, error }` with the encoded failure.
 */
const callerResult = async <A, E>(
  agent: AgentFetch,
  caller: Credential,
  call: (api: OwnerClient) => Effect.Effect<A, E>,
): Promise<RpcResult<A>> =>
  encodeExit(
    await Effect.runPromiseExit(ownerCall(agent, caller, caller.kind === 'client' ? PROBE_MEMBER : undefined, call)),
  )

/** A client's question in main (`POST /api/agent/ask`), as /mcp's `ask_agent` asks it, labelled `author`. */
export const askResult = (agent: AgentFetch, author: string, input: string, operationId: string, waitMs: number) =>
  callerResult(agent, fixtureClient(author), (api) => api.agent.ask({ payload: { input, operationId, waitMs } }))

/** Main's newest `limit` messages (`GET /api/agent/recent`), as /mcp's `get_recent_messages` reads them. */
export const recentResult = (agent: AgentFetch, limit: number) =>
  callerResult(agent, fixtureClient(), (api) => api.agent.recent({ query: { limit } }))

/** `value` without the fields it leaves undefined, as an endpoint's query takes it. */
const given = <T extends object>(value: T): T =>
  // SAFETY: dropping undefined fields keeps every present field and its type.
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T

/** One inspection read (`GET /api/inspect/…`) by its kind, as /mcp's `inspect_*` tools read it. */
export const inspectResult = (agent: AgentFetch, query: InspectQuery): Promise<RpcResult<unknown>> =>
  callerResult(agent, fixtureClient(), (api): Effect.Effect<unknown, unknown> => {
    const { kind, ...fields } = query
    switch (kind) {
      case 'conversations':
        return api.inspect.conversations()
      case 'conversation':
        return api.inspect.conversation({ query: given({ conversation: query.conversation, before: query.before }) })
      case 'turns':
        return api.inspect.turns({ query: given({ ...fields }) })
      case 'turn':
        return api.inspect.turn({ query: { operation: query.operationId } })
      case 'problems':
        return api.inspect.problems({ query: given({ ...fields }) })
      case 'flows':
        return api.inspect.flows({ query: given({ ...fields }) })
      case 'details':
        return api.inspect.details({ query: given({ ...fields }) })
    }
  })
