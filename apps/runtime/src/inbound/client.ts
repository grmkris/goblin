import { OwnerApi } from '@goblin/contracts/api'
import { type EventWebhookResult, FORWARDED_HEADER, InternalApi } from '@goblin/contracts/internal'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { type AppError, NotFound, isAppError, toAppError } from '../http/errors.ts'
import type { EventWebhook } from '../mcp/events/engine.ts'
import { CALLER_HEADER, type Caller, callerHeader } from '../http/api/principal.ts'

/** The part of an agent's Durable Object stub the internal API is called through. */
export type AgentFetch = { readonly fetch: (request: Request) => Promise<Response> }

/** The internal API's typed client (`@goblin/contracts/internal`). */
export type InternalClient = HttpApiClient.ForApi<typeof InternalApi>

/** `agent`'s own `fetch` as the HTTP client's transport. */
const transport = (agent: AgentFetch) =>
  // SAFETY: the HTTP client calls its Fetch only as `fetch(url, init)`; nothing reads the members some runtimes' types
  // add to `fetch` (Bun's `preconnect`, which the web's typecheck of the Worker sees).
  ((input: RequestInfo | URL, init?: RequestInit) => agent.fetch(new Request(input, init))) as typeof globalThis.fetch

/**
 * One call of the agent's internal API over `agent`'s own `fetch`, quoting `ref` (the Worker's reference for the
 * request it serves): its value, or the `AppError` the agent answered. Anything else (the stub failed, an answer that
 * does not decode) is ours: reported, and `Internal`.
 */
export const internalCall = <A, E>(
  agent: AgentFetch,
  call: (api: InternalClient) => Effect.Effect<A, E>,
  ref?: string,
): Effect.Effect<A, AppError> =>
  HttpApiClient.make(InternalApi, {
    baseUrl: 'https://agent',
    ...(ref === undefined
      ? {}
      : { transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader('x-goblin-ref', ref)) }),
  }).pipe(
    Effect.flatMap(call),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, transport(agent)),
    Effect.catch((failure) => Effect.fail(isAppError(failure) ? failure : toAppError(failure, 'internal.call'))),
  )

/** The owner API's typed client. */
export type OwnerClient = HttpApiClient.ForApi<typeof OwnerApi>

/**
 * One call of the owner API over `agent`'s own `fetch` for a caller on /mcp (ADR 0086): an owner forward carrying the
 * caller, as the edge forwards a key's request, so owner admission, the caller's scopes and its reach apply as they do
 * over HTTP. Its value, or the `AppError` the agent answered; anything else is reported, and `Internal`.
 */
export const ownerCall = <A, E>(
  agent: AgentFetch,
  caller: Caller,
  call: (api: OwnerClient) => Effect.Effect<A, E>,
): Effect.Effect<A, AppError> =>
  HttpApiClient.make(OwnerApi, {
    baseUrl: 'https://agent',
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeaders({ [FORWARDED_HEADER]: 'owner', [CALLER_HEADER]: callerHeader(caller) }),
    ),
  }).pipe(
    Effect.flatMap(call),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, transport(agent)),
    Effect.catch((failure) => Effect.fail(isAppError(failure) ? failure : toAppError(failure, 'owner.call'))),
  )

/**
 * An MCP Events webhook delivered to the agent's ingress (`/internal/mcp-events`), as the sender's answer. A failure
 * of ours is transient: 503, so the sender keeps the subscription and retries. Any other failure (authority off, a
 * bad signature) is that failure.
 */
export const deliverEvents = (
  agent: AgentFetch,
  webhook: EventWebhook,
  ref?: string,
): Effect.Effect<EventWebhookResult, AppError> =>
  internalCall(
    agent,
    (api) =>
      api.inbound.mcpEvents({
        params: { connectionId: webhook.connectionId },
        payload: webhook.body,
        headers: {
          'x-mcp-subscription-id': webhook.subscriptionId,
          'webhook-id': webhook.id,
          'webhook-timestamp': webhook.timestamp,
          'webhook-signature': webhook.signature,
        },
      }),
    ref,
  ).pipe(Effect.catchTag('Internal', () => Effect.succeed({ status: 503 } as const)))

/** A file link the agent will not serve: a link says no more than that it leads nowhere. */
const gone = () => Effect.fail(new NotFound({ what: 'file' }))

/**
 * The owner file a checked file link names (`/internal/files/linked`, ADR 0070): its bytes as they stream from the
 * agent, and the type and name its answer carries. Anything the agent refuses (the file is gone, resident authority
 * lapsed) is `NotFound`.
 */
export const linkedFile = (
  agent: AgentFetch,
  path: string,
  ref?: string,
): Effect.Effect<
  { readonly body: ReadableStream<Uint8Array>; readonly type?: string; readonly disposition?: string },
  AppError
> =>
  internalCall(
    agent,
    (api) => api.inbound.linkedFile({ query: { path }, responseMode: 'decoded-and-response' }),
    ref,
  ).pipe(
    Effect.map(([body, answer]) => ({
      body: Stream.toReadableStream(body),
      ...(answer.headers['content-type'] === undefined ? {} : { type: answer.headers['content-type'] }),
      ...(answer.headers['content-disposition'] === undefined
        ? {}
        : { disposition: answer.headers['content-disposition'] }),
    })),
    Effect.catchTags({ NotFound: gone, InvalidInput: gone, ResidentInactive: gone, Forbidden: gone }),
  )
