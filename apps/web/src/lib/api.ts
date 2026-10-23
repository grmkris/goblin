import { AccountApi, OwnerApi, WorkspaceAccountApi } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { makeApiQuery } from './query/api-query.ts'
import { crashReporter } from './query/crash-report.ts'
import { apiPath } from './workspace-path.ts'

/**
 * A short id for one request, sent as `x-goblin-request` by every call the browser makes (the typed clients, Better
 * Auth, `/health`, file bytes): what a failure quotes when no answer came back.
 */
export const requestId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 8)

/**
 * What every API request carries: a fresh `x-goblin-request` id, the CSRF header on every write, and the operation a
 * write runs as (`withOperation`).
 */
const apiHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  operation: string | undefined,
): Readonly<Record<string, string>> => ({
  'x-goblin-request': requestId(),
  ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { 'x-goblin-csrf': '1' }),
  ...(operation === undefined ? {} : { 'x-goblin-operation': operation }),
})

/**
 * The workspace one call is for when it is not this page's (`inWorkspaceOf`): a person's own page (the consent page,
 * Settings' MCP clients) reads what each of their workspaces holds to choose a grant's reach in it.
 */
const CallWorkspace = Context.Reference<string | undefined>('goblin/api/CallWorkspace', {
  defaultValue: () => undefined,
})

/** Run `call` in the workspace at `slug` rather than this page's. */
export const inWorkspaceOf =
  (slug: string) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(call, CallWorkspace, slug)

/**
 * Every call under a workspace (`/w/<slug>/api/…`, ADR 0089): the address says which workspace it is, this page's
 * unless the call names another (`inWorkspaceOf`).
 */
const inThisWorkspace = HttpClient.mapRequestEffect((request) =>
  Effect.gen(function* () {
    const slug = yield* CallWorkspace
    return HttpClientRequest.setUrl(request, slug === undefined ? apiPath(request.url) : `/w/${slug}${request.url}`)
  }),
)

/** The workspace's API, served by its agent: same-origin, with the session cookie, under the page's workspace. */
export const owner = makeApiQuery({
  id: 'goblin/OwnerApi',
  client: HttpApiClient.make(OwnerApi, { transformClient: inThisWorkspace }),
  headers: apiHeaders,
})
/** The workspace's own records the Worker answers without waking its agent: its API keys and the member's clients. */
export const workspaceAccount = makeApiQuery({
  id: 'goblin/WorkspaceAccountApi',
  client: HttpApiClient.make(WorkspaceAccountApi, { transformClient: inThisWorkspace }),
  headers: apiHeaders,
})
/** The person's own API, answered by the Worker: their workspaces, and crash reports. */
export const account = makeApiQuery({
  id: 'goblin/AccountApi',
  client: HttpApiClient.make(AccountApi),
  headers: apiHeaders,
})

/** Reports a crash nothing on the page caught (`crash-report.ts`) to `POST /api/client-errors`. */
export const reportCrash = crashReporter((report) => {
  account
    .run((api) => api.clientErrors.report({ payload: report }))
    .catch(() => {
      // expected: a report that cannot be sent is dropped; it must never become another crash.
    })
})
