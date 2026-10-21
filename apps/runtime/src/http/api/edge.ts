import type { CallerScope, WorkspaceView } from '@goblin/contracts'
import {
  AccountApi,
  AppError,
  ErrorEnvelope,
  Forbidden,
  NotFound,
  OwnerApi,
  WorkspaceAccountApi,
} from '@goblin/contracts/api'
import { FORWARDED_HEADER } from '@goblin/contracts/internal'
import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as HttpRouter from 'effect/http/HttpRouter'
import type * as HttpServerRequest from 'effect/http/HttpServerRequest'
import type * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { type LineLevel, LoggerLive, logEvent } from '../../observability/logger.ts'
import { ReporterLive } from '../../observability/report.ts'
import { readBytes } from '../body.ts'
import { crossOrigin, forgedWrite } from '../csrf.ts'
import { attempt, isAppError } from '../errors.ts'
import type { Person } from '../../auth/workspaces.ts'
import { AccountApiLayer, AccountRequest, type AccountRecords, WorkspaceAccountApiLayer } from './account.ts'
import {
  RequestContext,
  type RequestFacts,
  type RouteNames,
  endpointScopes,
  requestFacts,
  routeNames,
  routeTemplate,
} from './context.ts'
import {
  CALLER_HEADER,
  type Caller,
  type KeyGrant,
  MEMBER_HEADER,
  type Member,
  bearerKey,
  callerHeader,
  memberHeader,
} from './principal.ts'
import { answer, refusal, secured } from './render.ts'

/**
 * The Worker side of the typed API (ADRs 0038, 0089). The Worker keeps the session, origin and CSRF checks and answers
 * the account APIs itself. It forwards every other request to the agent of one workspace, marked as an owner forward so
 * the agent never takes it for an internal request, with who it comes from. The credential decides the workspace: a
 * member's session names it in the path (`/w/<workspace slug>/api/…`), checked against their membership; a server's API
 * key (ADR 0081) belongs to one and reaches it at `/api/…`.
 */

/**
 * Runs one of the Worker's own programs to its value (the Events webhook, the edge's own build): with the
 * agent's bridge (runtime/bridge.ts), the only place Effects are run. It rejects with the program's failure.
 */
export const runAtEdge = <A, E>(program: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(program)

/** The part of an agent's Durable Object stub the edge calls. */
type AgentFetch = { readonly fetch: (request: Request) => Promise<Response> }

/** What the edge asks of the deployment, for one request. */
export interface Edge {
  /** The app's own origin: every browser write comes from it. */
  readonly origin: string
  /** The signed-in person of a request, from its session cookie alone: any `Authorization` header is refused. */
  readonly session: (request: Request) => Effect.Effect<Person, AppError>
  /**
   * The workspace a server's API key belongs to, and what it may reach; `Unauthenticated` for any key that does not
   * admit.
   */
  readonly key: (key: string) => Effect.Effect<KeyGrant & { readonly workspaceId: string }, AppError>
  /** A person's membership of the workspace at a slug, read now: the workspace and their role, or none. */
  readonly membership: (userId: string, slug: string) => Effect.Effect<WorkspaceView | undefined, AppError>
  /** A workspace's agent, the one named by its ID. */
  readonly agent: (workspaceId: string) => AgentFetch
  /** The account's own records, for the account APIs. */
  readonly records: AccountRecords
}

/** What the agent receives besides method, path and body. Cookies and authorization stay at the edge. */
const FORWARDED = [
  'content-type',
  'content-length',
  'accept',
  'last-event-id',
  'x-goblin-request',
  'x-goblin-operation',
  // An MCP App's own calls (`x-mcp-caller: app`) are held to the App's grants rather than the owner's.
  'x-mcp-caller',
] as const
/** The JSON body bound of `http/body.ts`; file uploads stream through to the agent's own limits. */
const JSON_BODY_LIMIT = 65_536
/** A crash report is at most 2 KiB of JSON (`ClientErrorReport`). */
const REPORT_BODY_LIMIT = 4096
const FILES = '/api/files'

/** The owner paths the edge forwards: under `/api/`, never the account API's. */
const OWNER_PREFIX = '/api/'

/** A member's path: a workspace's slug, then the API path its agent or the workspace account API answers. */
const WORKSPACE_PATH = /^\/w\/([\w-]{1,200})(\/api\/.*)$/u

/** Who a forwarded request comes from: a member (a session) or a caller (a key). */
type Principal = { readonly member: Member } | { readonly caller: Caller }

/**
 * The headers an owner request carries to its agent: the edge's reference, the owner-forward mark and `FORWARDED`;
 * then its member, or a key's grant and never an App's caller mark.
 */
const forwardedHeaders = (request: Request, ref: string, principal: Principal): Headers => {
  const headers = new Headers({ 'x-goblin-ref': ref, [FORWARDED_HEADER]: 'owner' })
  const keyed = 'caller' in principal
  for (const name of FORWARDED) {
    const value = request.headers.get(name)
    if (value !== null && !(keyed && name === 'x-mcp-caller')) headers.set(name, value)
  }
  if (keyed) headers.set(CALLER_HEADER, callerHeader(principal.caller))
  else headers.set(MEMBER_HEADER, memberHeader(principal.member))
  return headers
}

/** The edge's reference for a request: Cloudflare's ray id, or a random one where there is none (a local run). */
export const refOf = (request: Request): string =>
  request.headers.get('cf-ray') ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16)

/** A write from a foreign Origin, or one without the CSRF header (`csrf.ts`). */
const refusedWrite = (request: Request, edge: Edge): Effect.Effect<void, AppError> =>
  crossOrigin(request, edge.origin) || forgedWrite(request, edge.origin)
    ? Effect.fail(new Forbidden({ reason: crossOrigin(request, edge.origin) ? 'origin' : 'csrf' }))
    : Effect.void

/**
 * Admission of a signed-in person, in this order: a write from a foreign Origin, the session, then the CSRF header on
 * every write. The person it admitted. No plan is read here: the agent checks it where something needs one.
 */
const admitPerson = (request: Request, edge: Edge): Effect.Effect<Person, AppError> =>
  Effect.gen(function* () {
    if (crossOrigin(request, edge.origin)) return yield* new Forbidden({ reason: 'origin' })
    const person = yield* edge.session(request)
    yield* refusedWrite(request, edge)
    return person
  })

/**
 * A member of the workspace at `slug` (ADR 0089): the person's session, then their membership, read now; `NotFound` if
 * none.
 */
const admitMember = (
  request: Request,
  edge: Edge,
  slug: string,
): Effect.Effect<{ readonly person: Person; readonly workspace: WorkspaceView }, AppError> =>
  Effect.gen(function* () {
    const person = yield* admitPerson(request, edge)
    const workspace = yield* edge.membership(person.id, slug)
    if (workspace === undefined) return yield* new NotFound({ what: 'workspace' })
    return { person, workspace }
  })

/**
 * Admission of a server by its API key (ADR 0081): a key is a server's, so a browser's cookie or Origin with it is
 * refused; the key must admit, and hold the scope of the endpoint the request names (`scope`, none for an endpoint no
 * key reaches). The workspace the key belongs to, and the key as the request's caller (ADR 0086).
 */
const admitKey = (
  request: Request,
  edge: Edge,
  key: string,
  scope: CallerScope | undefined,
): Effect.Effect<{ readonly workspaceId: string; readonly caller: Caller }, AppError> =>
  Effect.gen(function* () {
    if (request.headers.has('cookie') || request.headers.has('origin'))
      return yield* new Forbidden({ reason: 'key_browser' })
    const { workspaceId, ...grant } = yield* edge.key(key)
    if (scope === undefined || !grant.scopes.some((held) => held === scope))
      return yield* new Forbidden({ reason: 'scope' })
    return { workspaceId, caller: { kind: 'key', ...grant } }
  })

/** A body read up to `limit` bytes; past it, `PayloadTooLarge` (`readBytes`). */
const bounded = (request: Request, limit: number): Effect.Effect<Uint8Array<ArrayBuffer> | null, AppError> =>
  request.body === null ? Effect.succeed(null) : attempt(() => readBytes(request, limit))

const decodeEnvelope = Schema.decodeUnknownOption(ErrorEnvelope)

/** A failure's code, read from its envelope body; none for any other body. */
const codeOf = (response: Response): Effect.Effect<string | undefined> =>
  response.headers.get('content-type')?.startsWith('application/json') === true
    ? Effect.tryPromise(() => response.clone().json()).pipe(
        Effect.map((body) => Option.getOrUndefined(decodeEnvelope(body))?.error.code),
        // expected: a body that is not an envelope only leaves the code out of the failure line.
        Effect.orElseSucceed(() => undefined),
      )
    : Effect.succeed(undefined)

/**
 * An agent's refusal that says when to come back (`retryAfter`: a key past its rate limit, ADR 0085) with
 * `Retry-After`; any other answer as it is.
 */
const withRetryAfter = (response: Response): Effect.Effect<Response> =>
  response.status !== 401 || response.headers.get('content-type')?.startsWith('application/json') !== true
    ? Effect.succeed(response)
    : Effect.tryPromise(() => response.clone().json()).pipe(
        Effect.map((body) => {
          const retry = Option.getOrUndefined(decodeEnvelope(body))?.error.retryAfter
          if (retry === undefined) return response
          const answered = new Response(response.body, response)
          answered.headers.set('retry-after', String(retry))
          return answered
        }),
        // expected: a body that is not an envelope is answered as the agent sent it.
        Effect.orElseSucceed(() => response),
      )

/** An answer the owner made happen (absent, unpaid, taken, too fast) is information; anything else is a warning. */
const levelOf = (status: number): LineLevel =>
  status >= 500 ? 'error' : [401, 402, 404, 409, 429].includes(status) ? 'info' : 'warn'

/**
 * One `http.failure` line for each failed answer the edge returns, its own refusals and the agent's alike: the route
 * template, method, status, code, reference, the browser's request and operation ids, and the agent. Never content.
 */
const failureLine = (response: Response, facts: RequestFacts, method: string, agent: string | undefined) =>
  response.status < 400
    ? Effect.void
    : Effect.flatMap(codeOf(response), (code) =>
        logEvent(levelOf(response.status), 'http.failure', {
          route: facts.route,
          method,
          status: response.status,
          ...(code === undefined ? {} : { code }),
          ...(facts.ref === undefined ? {} : { ref: facts.ref }),
          ...(facts.request === undefined ? {} : { request: facts.request }),
          ...(facts.operation === undefined ? {} : { operation: facts.operation }),
          ...(agent === undefined ? {} : { agent }),
        }),
      )

/**
 * Runs `serve` for one request: its response, or the envelope of the `AppError` it failed with, quoting the edge's
 * reference, then the failure line. `serve` names the agent (a workspace's ID) once it knows it.
 */
const settle = (
  request: Request,
  facts: RequestFacts,
  serve: (known: (agent: string) => void) => Effect.Effect<Response, AppError>,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    let agent: string | undefined
    const served = serve((name) => {
      agent = name
    })
    // expected: an AppError is answered as its envelope, and failureLine below logs it.
    const response = yield* Effect.catchIf(served, isAppError, (error) => Effect.succeed(refusal(error, facts.ref)))
    yield* failureLine(response, facts, request.method, agent)
    return response
  })

/** The account API's paths, a person's; anything else under them is a 404 in the envelope. */
const ACCOUNT_PATHS = ['/api/workspaces', '/api/client-errors'] as const
/** The workspace account API's paths, under `/w/<workspace slug>`: answered by the Worker, never the agent. */
const WORKSPACE_ACCOUNT_PATHS = ['/api/clients', '/api/keys'] as const
const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)
export const isAccountPath = (path: string): boolean => ACCOUNT_PATHS.some((prefix) => under(path, prefix))
const isWorkspaceAccountPath = (path: string): boolean => WORKSPACE_ACCOUNT_PATHS.some((prefix) => under(path, prefix))

/** Whether `path` is a member's (`/w/<workspace slug>/api/…`), which `EdgeHttp.workspace` answers. */
export const isWorkspacePath = (path: string): boolean => WORKSPACE_PATH.test(path)

/**
 * Each account group's admission: a person's workspaces for any signed-in person (a key never reaches them), crash
 * reports for anyone. A crash report needs no session, but one that comes with a session names its person (its flow
 * point is indexed by their hash).
 */
const admitAccount = (group: string, request: Request, edge: Edge): Effect.Effect<Option.Option<Person>, AppError> =>
  group === 'clientErrors'
    ? Effect.andThen(refusedWrite(request, edge), sessionPerson(request, edge))
    : Effect.map(admitPerson(request, edge), Option.some)

/** The signed-in person of a request that may come without a session: none for no cookie, or one that does not admit. */
const sessionPerson = (request: Request, edge: Edge): Effect.Effect<Option.Option<Person>> =>
  request.headers.has('cookie') ? Effect.option(edge.session(request)) : Effect.succeedNone

/** `request` at `path` instead, for naming its route; its body stays with the original. */
const atPath = (request: Request, path: string, search: string): Request =>
  new Request(`https://edge${path}${search}`, { method: request.method })

export interface EdgeHttp {
  /** Answers a request under the account API's paths (`isAccountPath`) in the Worker, without waking an agent. */
  readonly account: (request: Request, edge: Edge) => Effect.Effect<Response>
  /**
   * Admits a member's request (`/w/<workspace slug>/api/…`, `isWorkspacePath`) by their session and membership, then
   * answers the workspace account API's paths in the Worker and forwards every other to the workspace's agent with the
   * member, under its `/api/…` path.
   */
  readonly workspace: (request: Request, edge: Edge) => Effect.Effect<Response>
  /**
   * Admits a server's request by its API key and forwards it to the agent of the key's workspace. Only an `/api/*` path
   * that is not the account API's is forwarded, as the parsed URL names it (`..` and `%2e%2e` already resolved); any
   * other is a 404 in the envelope, and so is one without a key: a session names its workspace in the path.
   */
  readonly owner: (request: Request, edge: Edge) => Effect.Effect<Response>
  /**
   * One of the Worker's own routes (`/mcp`, `/hooks/*`, anything else it does not serve): `serve`'s answer with the
   * API's headers, or the envelope of the failure it ended in, and the failure line either way. `serve` is given the
   * request's reference, which the answer quotes.
   */
  readonly route: (
    request: Request,
    serve: (ref: string) => Effect.Effect<Response, AppError>,
  ) => Effect.Effect<Response>
}

/** One admitted request on its way to an agent: as its `/api/…` `path` and `search`, for `principal`. */
interface Forward {
  readonly request: Request
  readonly ref: string
  readonly path: string
  readonly search: string
  readonly principal: Principal
  readonly agent: AgentFetch
}

/**
 * Forwards a request to its agent: its body bounded unless it is a file upload, which streams through to the agent's
 * own limits.
 */
const forward = ({ request, ref, path, search, principal, agent }: Forward) =>
  Effect.gen(function* () {
    const files = path === FILES || path.startsWith(`${FILES}/`)
    const body = files ? request.body : yield* bounded(request, JSON_BODY_LIMIT)
    const headers = forwardedHeaders(request, ref, principal)
    // A streamed body needs `duplex` outside workerd (Node, the unit tests); workerd ignores it and its types omit it.
    // The agent's redirect (an outbound sign-in's callback, to Connections) goes to the browser: a followed one would
    // ask the agent for a page it does not serve.
    const init = { method: request.method, headers, body, duplex: 'half', redirect: 'manual' } as const
    const response = yield* attempt(() => agent.fetch(new Request(`https://agent${path}${search}`, init)))
    return secured(yield* withRetryAfter(response), ref)
  })

/** An account API's router: it reads the request's account records and facts. */
type AccountHttp = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  Scope.Scope | HttpServerRequest.HttpServerRequest | AccountRequest | RequestContext
>

/** What the edge's routes share once built: the account APIs' routers, its logger and reporter, and route names. */
interface Built {
  readonly accountHttp: AccountHttp
  readonly workspaceHttp: AccountHttp
  readonly observed: Context.Context<never>
  readonly accountRoute: RouteNames
  readonly workspaceAccountRoute: RouteNames
  readonly ownerRoute: RouteNames
  readonly ownerScopes: ReadonlyMap<string, CallerScope>
}

const accountOf =
  ({ accountHttp, accountRoute, observed }: Built): EdgeHttp['account'] =>
  (request, edge) => {
    const path = new URL(request.url).pathname
    const route = accountRoute(request)
    const facts = { ...requestFacts(request, route ?? routeTemplate(path)), ref: refOf(request) }
    const served = settle(request, facts, () =>
      Effect.gen(function* () {
        if (route === undefined) return yield* new NotFound({ what: 'route' })
        const group = route.slice(0, route.indexOf('.'))
        const person = yield* admitAccount(group, request, edge)
        const limit = group === 'clientErrors' ? REPORT_BODY_LIMIT : JSON_BODY_LIMIT
        const body = yield* bounded(request, limit)
        const admitted = new Request(request.url, { method: request.method, headers: request.headers, body })
        return yield* answer(
          accountHttp.pipe(
            Effect.provideService(AccountRequest, {
              records: edge.records,
              person,
              workspace: Option.none(),
              headers: request.headers,
            }),
            Effect.provideService(RequestContext, facts),
          ),
          admitted,
          facts,
        )
      }),
    )
    return Effect.provideContext(served, observed)
  }

const workspaceOf =
  ({ workspaceHttp, workspaceAccountRoute, ownerRoute, observed }: Built): EdgeHttp['workspace'] =>
  (request, edge) => {
    const url = new URL(request.url)
    const [, slug = '', path = url.pathname] = WORKSPACE_PATH.exec(url.pathname) ?? []
    const named = atPath(request, path, url.search)
    const inAccount = isWorkspaceAccountPath(path)
    const route = inAccount ? workspaceAccountRoute(named) : ownerRoute(named)
    const facts = { ...requestFacts(request, route ?? routeTemplate(path)), ref: refOf(request) }
    const served = settle(request, facts, (known) =>
      Effect.gen(function* () {
        if (slug === '' || isAccountPath(path)) return yield* new NotFound({ what: 'route' })
        const { person, workspace: member } = yield* admitMember(request, edge, slug)
        known(member.id)
        if (!inAccount)
          return yield* forward({
            request,
            ref: facts.ref,
            path,
            search: url.search,
            principal: { member: { user: person.id, role: member.role } },
            agent: edge.agent(member.id),
          })
        if (route === undefined) return yield* new NotFound({ what: 'route' })
        const body = yield* bounded(request, JSON_BODY_LIMIT)
        const admitted = new Request(`https://edge${path}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body,
        })
        const account = { records: edge.records, person: Option.some(person), workspace: Option.some(member) }
        return yield* answer(
          workspaceHttp.pipe(
            Effect.provideService(AccountRequest, { ...account, headers: request.headers }),
            Effect.provideService(RequestContext, facts),
          ),
          admitted,
          facts,
        )
      }),
    )
    return Effect.provideContext(served, observed)
  }

const ownerOf =
  ({ ownerRoute, ownerScopes, observed }: Built): EdgeHttp['owner'] =>
  (request, edge) => {
    const url = new URL(request.url)
    const facts = { ...requestFacts(request, ownerRoute(request) ?? routeTemplate(url.pathname)), ref: refOf(request) }
    const served = settle(request, facts, (known) =>
      Effect.gen(function* () {
        const token = bearerKey(request)
        if (!url.pathname.startsWith(OWNER_PREFIX) || isAccountPath(url.pathname) || token === undefined)
          return yield* new NotFound({ what: 'route' })
        const { workspaceId, caller } = yield* admitKey(request, edge, token, ownerScopes.get(facts.route))
        known(workspaceId)
        return yield* forward({
          request,
          ref: facts.ref,
          path: url.pathname,
          search: url.search,
          principal: { caller },
          agent: edge.agent(workspaceId),
        })
      }),
    )
    return Effect.provideContext(served, observed)
  }

const routeOf =
  ({ observed }: Built): EdgeHttp['route'] =>
  (request, serve) => {
    const facts = { ...requestFacts(request, routeTemplate(new URL(request.url).pathname)), ref: refOf(request) }
    const served = settle(request, facts, () =>
      Effect.map(serve(facts.ref), (response) => secured(response, facts.ref)),
    )
    return Effect.provideContext(served, observed)
  }

/**
 * The edge, built once per isolate: the account APIs' routers live for the isolate, in a scope that is never closed,
 * with goblin's logger and failure reporter.
 */
export const makeEdgeHttp: Effect.Effect<EdgeHttp> = Effect.gen(function* () {
  const scope = Scope.makeUnsafe()
  const built: Built = {
    accountHttp: yield* HttpRouter.toHttpEffect(AccountApiLayer).pipe(Scope.provide(scope)),
    workspaceHttp: yield* HttpRouter.toHttpEffect(WorkspaceAccountApiLayer).pipe(Scope.provide(scope)),
    observed: yield* Layer.build(Layer.mergeAll(LoggerLive, ReporterLive)).pipe(Scope.provide(scope)),
    accountRoute: routeNames(AccountApi),
    workspaceAccountRoute: routeNames(WorkspaceAccountApi),
    ownerRoute: routeNames(OwnerApi),
    ownerScopes: endpointScopes(OwnerApi),
  }
  return { account: accountOf(built), workspace: workspaceOf(built), owner: ownerOf(built), route: routeOf(built) }
})
