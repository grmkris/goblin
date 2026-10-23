import { type CallerScope, PollEvents, SubscribeEvents, UnsubscribeEvents } from '@goblin/contracts'
import { AppError, OwnerApi } from '@goblin/contracts/api'
import { type McpServer, ProtocolError } from '@modelcontextprotocol/server'
import type * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import { endpointScopes } from '../http/api/context.ts'
import { toAppError } from '../http/errors.ts'
import { EVENTS_EXTENSION } from '../mcp/events/protocol.ts'
import type { OwnerClient } from './client.ts'
import type { CallerReach } from './mcp-server.ts'
import type { OwnerCaller } from './tools.ts'

// The MCP Events goblin publishes, on /mcp (ADR 0112): `events/list`, `subscribe`, `unsubscribe` and `poll`, each a call
// of its `events` endpoint as the caller (`ownerCall`), so admission, the `conversations` scope, the minute's limit and
// a key's reach are the owner API's own; `events/stream` is unsupported. An OAuth client that names its workspace on
// every call names it inside `arguments` (in `params` for `events/list`), as its tools take `workspace`.

/**
 * Each method, by the endpoint it calls (`<group>.<endpoint>`).
 *
 * @internal The parity test holds the tools and these to the endpoints annotated `EndpointScope`, one to one.
 */
export const EVENT_METHODS = {
  'events/list': 'events.list',
  'events/subscribe': 'events.subscribe',
  'events/unsubscribe': 'events.unsubscribe',
  'events/poll': 'events.poll',
} as const

/** What a server answers Events with, by the profile's error codes (myapps `packages/mcp/src/events/errors.ts`). */
const CODES = {
  invalid: [-32602, 'InvalidParams'],
  notFound: [-32011, 'NotFound'],
  forbidden: [-32012, 'Forbidden'],
  quota: [-32013, 'ResourceExhausted'],
  unsupported: [-32014, 'Unsupported'],
  callback: [-32015, 'CallbackEndpointError'],
  internal: [-32603, 'InternalError'],
} as const

/** The profile's code of a refusal, by its tag and reason. */
const codeOf = (error: AppError): keyof typeof CODES =>
  Match.value(error).pipe(
    Match.tags({
      InvalidInput: () => 'invalid' as const,
      InvalidArguments: () => 'invalid' as const,
      NotFound: () => 'notFound' as const,
      Forbidden: () => 'forbidden' as const,
      AccessInsufficient: () => 'forbidden' as const,
      GrantDenied: () => 'forbidden' as const,
      ResidentInactive: () => 'forbidden' as const,
      Unauthenticated: ({ reason }) => (reason === 'rate_limited' ? ('quota' as const) : ('forbidden' as const)),
      Conflict: ({ reason }) =>
        reason === 'event_callback'
          ? ('callback' as const)
          : reason === 'event_subscriptions'
            ? ('quota' as const)
            : ('invalid' as const),
    }),
    Match.orElse(() => 'internal' as const),
  )

const encodeError = Schema.encodeSync(AppError)

/** A refusal as the protocol error a client reads: its code, and the safe fields the owner API answers with it. */
export function eventError(cause: unknown): ProtocolError {
  const error = toAppError(cause)
  const [code, message] = CODES[codeOf(error)]
  return new ProtocolError(code, message, encodeError(error))
}
const standardParams = Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown))

/** A request's `arguments` and the workspace a client named among them, taken back out. */
const named = (params: Readonly<Record<string, unknown>>) => {
  const { _meta: _envelope, ...rest } = params
  const args = Predicate.isReadonlyObject(rest['arguments']) ? { ...rest['arguments'] } : undefined
  const workspace = args?.['workspace']
  if (args !== undefined) delete args['workspace']
  return {
    params: { ...rest, ...(args === undefined ? {} : { arguments: args }) },
    workspace: typeof workspace === 'string' ? workspace : undefined,
  }
}

/** `params` as `schema` takes them, or the profile's invalid params. */
const decoded = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, params: unknown): S['Type'] =>
  Option.getOrThrowWith(Schema.decodeUnknownOption(schema)(params), () => new ProtocolError(-32602, 'InvalidParams'))

/** The descriptor's arguments with `workspace` among them, required, for a client that names one on every call. */
const withWorkspace = (
  listed: { readonly events: readonly { readonly inputSchema: object }[] },
  reach: CallerReach,
) => ({
  ...listed,
  events: listed.events.map((event) => {
    // SAFETY: goblin's own descriptor (`publish/event.ts`): an object schema with `properties`.
    const schema = event.inputSchema as { readonly properties?: object; readonly required?: readonly string[] }
    const workspace = {
      type: 'string',
      description: `The workspace, by id or slug: ${reach.workspaces.map(({ slug }) => slug).join(', ') || 'none now'}.`,
    }
    return {
      ...event,
      inputSchema: {
        ...schema,
        properties: { ...schema.properties, workspace },
        required: [...(schema.required ?? []), 'workspace'],
      },
    }
  }),
})

/** Whether a caller holding `scopes` reaches the published Events: the `conversations` scope. */
const reaches = (scopes: readonly CallerScope[]): boolean => {
  const scope = endpointScopes(OwnerApi).get(EVENT_METHODS['events/subscribe'])
  return scope !== undefined && scopes.includes(scope)
}

/** What the server's instructions add for a caller that reaches the published Events. */
export const EVENTS_GUIDE = (scopes: readonly CallerScope[]): string =>
  reaches(scopes)
    ? ' Instead of polling conversation_entries, subscribe to conversation.updated with events/subscribe for a signed webhook wake (at most one a second per chat, always one when its work ends), or poll it with events/poll; then read the chat with conversation_entries from your cursor.'
    : ''

/**
 * Declares the Events extension and serves its methods on `server` when the caller holds `conversations`: the
 * top-level `capabilities.events` (which the pinned SDK keeps on the wire, for `initialize` and `server/discover`)
 * and `extensions["io.modelcontextprotocol/events"]`.
 */
export function eventMethods(
  server: McpServer,
  scopes: readonly CallerScope[],
  call: OwnerCaller,
  reach: CallerReach | undefined,
): void {
  if (!reaches(scopes)) return
  // SAFETY: the SDK's ServerCapabilities type has no draft `events`; registerCapabilities merges it as given.
  server.server.registerCapabilities({ events: {}, extensions: { [EVENTS_EXTENSION]: {} } } as never)
  const answer = async <A>(run: (api: OwnerClient) => Effect.Effect<A, unknown>, workspace?: string) => {
    try {
      return await call(run, workspace)
    } catch (cause) {
      throw eventError(cause)
    }
  }
  server.server.setRequestHandler('events/list', { params: standardParams }, async (params) => {
    const workspace = typeof params['workspace'] === 'string' ? params['workspace'] : undefined
    const listed = await answer((api) => api.events.list(), workspace)
    return reach?.named === true ? withWorkspace(listed, reach) : listed
  })
  server.server.setRequestHandler('events/subscribe', { params: standardParams }, async (raw) => {
    const { params, workspace } = named(raw)
    const payload = decoded(SubscribeEvents, params)
    return answer((api) => api.events.subscribe({ payload }), workspace)
  })
  server.server.setRequestHandler('events/unsubscribe', { params: standardParams }, async (raw) => {
    const { params, workspace } = named(raw)
    const payload = decoded(UnsubscribeEvents, params)
    return answer((api) => api.events.unsubscribe({ payload }), workspace)
  })
  server.server.setRequestHandler('events/poll', { params: standardParams }, async (raw) => {
    const { params, workspace } = named(raw)
    const payload = decoded(PollEvents, params)
    return answer((api) => api.events.poll({ payload }), workspace)
  })
  server.server.setRequestHandler('events/stream', { params: standardParams }, () => {
    throw new ProtocolError(...CODES.unsupported)
  })
}
