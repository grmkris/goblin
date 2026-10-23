import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Chats } from '../chats/service.ts'
import {
  type GrantDenied,
  InvalidArguments,
  type NeedsAuthorization,
  NotFound,
  type ScopeRequired,
  UpstreamMcp,
  attempt,
  attemptSync,
} from '../http/errors.ts'
import { type McpCallInput, approvalResult, holdModelCall } from '../mcp/approvals/approval-request.ts'
import { keepModelApp } from '../mcp/apps/kept-app.ts'
import {
  connectRequiredResult,
  grantRequiredResult,
  mcpModelResult,
  scopeRequiredResult,
} from '../mcp/connections/extension.ts'
import { toolOffered } from '../mcp/connections/remote.ts'
import type { McpRequestOptions } from '../mcp/connections/types.ts'
import { materialize } from '../mcp/content/materialize.ts'
import { named } from '../mcp/servers/labels.ts'
import { McpConnections, McpServers, requireResident } from '../mcp/service.ts'
import { holdUrlRequest } from '../mcp/url-requests/url-request.ts'
import { FlowEvents } from '../observability/flows.ts'
import { requireRoutineSession } from '../routines/authority.ts'
import { bound } from '../runtime/boundary.ts'
import { AgentInput } from '../runtime/input.ts'
import { Setups } from '../setup/service.ts'
import { describeError } from '../telemetry/attributes.ts'
import { reachesConnection } from './power.ts'
import { connectionOutsideResult, mcpOff, outsideScopeResult } from './setup.ts'
import { ReadyResult } from './typed-tool.ts'

// The one way a model's call reaches a remote MCP tool (ADR 0101): `mcp_call` and a Persona fork's native tools both go
// through `callRemoteTool`, which makes every check again at each call, so a frozen tool set never lets a revoked grant
// or a changed setup run.

/** The Pi context a tool's execution runs in. */
export type ToolContext = Parameters<ToolRegistration['execute']>[2]

/** What a model's MCP tool checks before it runs: resident authority, then a routine run's own, when it is one. */
export const executionAuthority = (session: string) => Effect.andThen(requireResident, requireRoutineSession(session))

/** What the manager checks again right before a model's call leaves: the call's execution authority and scope. */
const dispatchAuthority = (session: string, input: { connectionId: string; name: string }) =>
  Effect.gen(function* () {
    yield* executionAuthority(session)
    if (!(yield* (yield* Setups).scope(session)).tool(input.connectionId, input.name))
      return yield* new NotFound({ what: 'tool scope' })
  })

/**
 * A call the owner has not granted becomes a request for their decision, but only for a tool that exists and the
 * model may call: anything else stays NotFound, so the owner is never asked about a tool that is not there. A tool the
 * connection does not list yet is listed once more first: the server may have just added it (ADR 0042).
 */
const grantRequired = (denied: GrantDenied, options: McpRequestOptions) =>
  Effect.gen(function* () {
    const connections = yield* McpConnections
    const known = yield* connections.connect(denied.connectionId, options)
    const snapshot = known.tools.some(({ name }) => name === denied.name)
      ? known
      : yield* connections.refreshTools(denied.connectionId, options)
    const tool = snapshot.tools.find((item) => item.name === denied.name)
    if (tool === undefined || !toolOffered(tool, 'model')) return yield* new NotFound({ what: `tool ${denied.name}` })
    const labels = yield* (yield* McpServers).labels()
    return grantRequiredResult(denied.connectionId, denied.name, named(labels, denied.connectionId))
  })

/** A call to a connection the owner has not signed in to, as the model reads it: the owner connects it (ADR 0063). */
const connectRequired = (needed: NeedsAuthorization, name: string) =>
  Effect.map(
    McpServers.use((servers) => servers.labels()),
    (labels) => connectRequiredResult(needed.connectionId, name, named(labels, needed.connectionId)),
  )

/** A call beyond the connection's granted scope, as the model reads it: the owner signs in again (ADR 0042). */
const scopeRequired = (required: ScopeRequired, name: string, session: string) =>
  Effect.gen(function* () {
    const connection = named(yield* (yield* McpServers).labels(), required.connectionId)
    const chat = Option.getOrUndefined(yield* (yield* Chats).chatOf(session))
    yield* FlowEvents.record({
      flow: 'scope_required',
      via: 'tool',
      actor: 'agent',
      ...(chat === undefined ? {} : { chat }),
      status: 'ok',
    })
    return scopeRequiredResult(required.connectionId, name, required.scope, connection)
  })

/**
 * What the model reads of a failed call. Arguments that do not fit the tool's input schema were sent nowhere: it reads
 * every problem, one per line, to fix them in one more call (ADR 0092). A call that timed out or lost its connection
 * may still have reached the server, so it is told to look before calling again: in the showcase run it sent a slow
 * `create_agent` twice.
 */
export const callFailure = (cause: unknown): string => {
  if (cause instanceof InvalidArguments)
    return `The arguments do not match ${cause.name}'s input schema; fix them and call again:\n${cause.problems.map((problem) => `- ${problem}`).join('\n')}`
  return cause instanceof UpstreamMcp && (cause.reason === 'timeout' || cause.reason === 'transport')
    ? `${describeError(cause)}. The call may have reached the server and taken effect: check its state with a read-only tool before calling it again, and never repeat a paid or one-time action blind.`
    : describeError(cause)
}

/**
 * Whether the model answering this conversation sees images: its Pi model takes image input (`pi/model.ts`), as pi-ai
 * decides when it sends a tool result's images. Asked only when a kept file is a small image, which is then shown to it
 * beside the file's reference (ADR 0065).
 */
const seesImages = (api: ToolExecutionApi, context: ToolContext) =>
  Effect.gen(function* () {
    const { pi } = yield* AgentInput
    const chosen = (yield* attempt(() => api.agent(context))).model
    const model = yield* attemptSync(() =>
      chosen === undefined ? pi.model : pi.models.getModel(chosen.provider, chosen.modelId),
    )
    return model?.input.includes('image') === true
  }).pipe(
    // expected: a model goblin cannot tell sees images reads the file's reference alone, which is enough.
    Effect.orElseSucceed(() => false),
  )

/** The request options of a model's call in conversation `api.conversationId`. */
export const requestFor = (api: ToolExecutionApi, signal: AbortSignal | undefined): McpRequestOptions => ({
  runContext: { conversationId: String(api.conversationId), taskId: String(api.taskId) },
  ...(signal === undefined ? {} : { signal }),
})

/**
 * One model call of remote tool `input.name` on connection `input.connectionId`, as the model reads its result. Every
 * check runs here, at each call, in order: execution authority (resident, a routine's), the conversation's scope (its
 * Topic's setup, a Persona's frozen one), the turn's power (a credential's connections, ADR 0115), the ask-first hold
 * and its approval card, then the manager's own: the exact owner grant and dispatch authority again right before each
 * HTTP dispatch, and the arguments against the tool's schema as listed now (ADR 0092). A URL request is held for the
 * owner, an App the result renders is kept, the files it hands over are kept in its Topic's folder (ADRs 0065, 0115),
 * and a missing grant, sign-in or scope becomes the owner's card.
 */
export const callRemoteTool = (input: McpCallInput, api: ToolExecutionApi, context: ToolContext) =>
  Effect.gen(function* () {
    const session = String(api.conversationId)
    yield* executionAuthority(session)
    const scope = yield* (yield* Setups).scope(session)
    // Switched off in this conversation: nothing is called, not even the grant check or a connection.
    const off = mcpOff(scope, input.connectionId, input.name)
    if (off !== undefined) return outsideScopeResult(off, scope)
    if (!(yield* reachesConnection(api, context, input.connectionId)))
      return connectionOutsideResult(input.connectionId)
    const held = yield* holdModelCall(session, api.callId, String(api.taskId), input)
    if (held !== undefined) return yield* approvalResult(session, api.callId, held.id, input)
    const connections = yield* McpConnections
    const recheck = yield* bound(dispatchAuthority(session, input))
    const request = requestFor(api, context.abortSignal)
    return yield* connections
      .callModelTool(input.connectionId, input.name, input.arguments, { authorize: recheck, ...request })
      .pipe(
        Effect.flatMap((outcome) =>
          Effect.gen(function* () {
            if (outcome.kind === 'url')
              return yield* holdUrlRequest(session, api.callId, String(api.taskId), input, outcome.prompt)
            yield* keepModelApp(session, api.callId, input)
            // The files the result hands over are kept in its Topic's folder (ADRs 0065, 0115), after the call.
            const received = yield* materialize(input.connectionId, outcome.result, {
              images: seesImages(api, context),
              ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
            })
            return mcpModelResult(input.connectionId, outcome.result, received)
          }),
        ),
        Effect.catchTag('GrantDenied', (denied) => grantRequired(denied, request)),
        Effect.catchTag('ScopeRequired', (required) => scopeRequired(required, input.name, session)),
        Effect.catchTag('NeedsAuthorization', (needed) => connectRequired(needed, input.name)),
      )
  })

/** {@link callRemoteTool}'s result as a typed tool returns it, whole. */
export const remoteToolResult = (input: McpCallInput, api: ToolExecutionApi, context: ToolContext) =>
  Effect.map(callRemoteTool(input, api, context), (result: ToolExecutionResult) => new ReadyResult(result))
