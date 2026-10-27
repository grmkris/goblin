import type { Need, WorkspaceView } from '@goblin/contracts'
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
import { stateWorkspace } from '../../mcp/oauth/sign-in.ts'
import { AccountRequest, type AccountRecords } from './account.ts'
import { type CredentialEdge, admitClient } from './admission.ts'
import { AccountApiLayer, WorkspaceAccountApiLayer } from './account-layers.ts'
import {
  RequestContext,
  type RequestFacts,
  type RouteNames,
  endpointAccess,
  requestFacts,
  routeNames,
  routeTemplate,
} from './context.ts'
import {
  CALLER_HEADER,
  type Credential,
  MEMBER_HEADER,
  type Member,
  bearerToken,
  credentialHeader,
  memberHeader,
  memberName,
} from './principal.ts'
import { answer, refusal, secured } from './render.ts'

/**
 * The Worker side of the typed API (ADRs 0038, 0089). The Worker keeps the session, origin and CSRF checks and answers
 * the account APIs itself. It forwards every other request to the agent of one workspace, marked as an owner forward so
 * the agent never takes it for an internal request, with who it comes from. The credential decides the workspace: a
 * member's session names it in the path (`/w/<workspace slug>/api/…`), checked against their membership, and so does an
 * OAuth token, a client's checked against the workspaces its grant reaches for its person (ADR 0116), an installed
 * app's against its installation (ADR 0118). Nothing reaches an agent on bare `/api/…` (ADR 0120). An outbound sign-in
 * comes back to one address for every workspace, its `state` naming the workspace, checked against the person's
 * membership the same way.
 */

/**
 * Runs one of the Worker's own programs to its value (the Events webhook, the edge's own build): with the
 * agent's bridge (runtime/bridge.ts), the only place Effects are run. It rejects with the program's failure.
 */
export const runAtEdge = <A, E>(program: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(program)

/** The part of an agent's Durable Object stub the edge calls. */
type AgentFetch = { readonly fetch: (request: Request) => Promise<Response> }

/** What the edge asks of the deployment, for one request: besides how it admits a credential (`CredentialEdge`). */
export interface Edge extends CredentialEdge {
  /** The signed-in person of a request, from its session cookie alone: any `Authorization` header is refused. */
  readonly session: (request: Request) => Effect.Effect<Person, AppError>
  /** A person's membership of the workspace at a slug, read now: the workspace and their role, or none. */
  readonly membership: (userId: string, slug: string) => Effect.Effect<WorkspaceView | undefined, AppError>
  /** A person's membership of the workspace with an ID, read now: the workspace and their role, or none. */
  readonly membershipOf: (userId: string, workspaceId: string) => Effect.Effect<WorkspaceView | undefined, AppError>
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
/**
 * A send's bound (ADR 0111): its body is AG-UI's `RunAgentInput`, and a stock client resends the whole conversation
 * with each one, of which goblin reads only the last message.
 */
const SEND_BODY_LIMIT = 1_048_576
/** The owner endpoints that take a send. */
const SENDS: ReadonlySet<string> = new Set(['conversations.submit', 'conversations.startThread'])
/** A crash report is at most 2 KiB of JSON (`ClientErrorReport`). */
const REPORT_BODY_LIMIT = 4096
const FILES = '/api/files'

/** A member's path: a workspace's slug, then the API path its agent or the workspace account API answers. */
const WORKSPACE_PATH = /^\/w\/([\w-]{1,200})(\/api\/.*)$/u

/**
 * Who a forwarded request comes from: a member (a session), a credential (an installed app, ADR 0118), or a credential
 * acting for its person as a member (an OAuth client, ADR 0116).
 */
type Principal =
  | { readonly member: Member; readonly credential?: undefined }
  | { readonly credential: Credential; readonly member?: Member }

/**
 * The headers an owner request carries to its agent: the edge's reference, the owner-forward mark and `FORWARDED`;
 * then its credential (never with an App's caller mark) and its member, whichever it has.
 */
const forwardedHeaders = (request: Request, ref: string, { credential, member }: Principal): Headers => {
  const headers = new Headers({ 'x-goblin-ref': ref, [FORWARDED_HEADER]: 'owner' })
  for (const name of FORWARDED) {
    const value = request.headers.get(name)
    if (value !== null && !(credential !== undefined && name === 'x-mcp-caller')) headers.set(name, value)
  }
  if (credential !== undefined) headers.set(CALLER_HEADER, credentialHeader(credential))
  if (member !== undefined) headers.set(MEMBER_HEADER, memberHeader(member))
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
 * A member of a workspace, at its slug or with its ID (ADR 0089): the person's session, then their membership, read
 * now; `NotFound` if none.
 */
const admitMember = (
  request: Request,
  edge: Edge,
  workspace: { readonly slug: string } | { readonly id: string },
): Effect.Effect<{ readonly person: Person; readonly workspace: WorkspaceView }, AppError> =>
  Effect.gen(function* () {
    const person = yield* admitPerson(request, edge)
    const member = yield* 'slug' in workspace
      ? edge.membership(person.id, workspace.slug)
      : edge.membershipOf(person.id, workspace.id)
    if (member === undefined) return yield* new NotFound({ what: 'workspace' })
    return { person, workspace: member }
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
 * An agent's refusal that says when to come back (`retryAfter`: a credential past its rate limit, ADR 0085) with
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
const ACCOUNT_PATHS = [
  '/api/workspaces',
  '/api/invitations',
  '/api/clients',
  '/api/grants',
  '/api/install',
  '/api/client-errors',
] as const
/** The workspace account API's paths, under `/w/<workspace slug>`: answered by the Worker, never the agent. */
const WORKSPACE_ACCOUNT_PATHS = ['/api/members', '/api/developer', '/api/installations'] as const
const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)
export const isAccountPath = (path: string): boolean => ACCOUNT_PATHS.some((prefix) => under(path, prefix))
const isWorkspaceAccountPath = (path: string): boolean => WORKSPACE_ACCOUNT_PATHS.some((prefix) => under(path, prefix))

/** Whether `path` is a member's (`/w/<workspace slug>/api/…`), which `EdgeHttp.workspace` answers. */
export const isWorkspacePath = (path: string): boolean => WORKSPACE_PATH.test(path)

/**
 * Each account endpoint's admission: a person's workspaces and invitations for any signed-in person (no credential
 * reaches them); crash reports, and an invitation's preview (its link is all a visitor has, ADR 0093), for anyone. One
 * that needs no session but comes with one names its person (a crash's flow point is indexed by their hash).
 */
const OPEN_ROUTES = new Set(['clientErrors.report', 'invitations.preview'])
const admitAccount = (route: string, request: Request, edge: Edge): Effect.Effect<Option.Option<Person>, AppError> =>
  OPEN_ROUTES.has(route)
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
   * member, under its `/api/…` path. An OAuth client's token there (ADR 0116) is admitted instead by the workspaces its
   * grant reaches, and only forwarded: the account paths are people's.
   */
  readonly workspace: (request: Request, edge: Edge) => Effect.Effect<Response>
  /**
   * Admits an outbound sign-in coming back (`SIGN_IN_CALLBACK`): the workspace its `state` names, the person's session
   * and their membership of it, read now; then forwards it to that workspace's agent as a member's request.
   */
  readonly signIn: (request: Request, edge: Edge) => Effect.Effect<Response>
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
  /** The endpoint it names (`conversations.submit`), or the path's area when it names none. */
  readonly route: string
  readonly path: string
  readonly search: string
  readonly principal: Principal
  readonly agent: AgentFetch
}

/**
 * Forwards a request to its agent: its body bounded (a send's higher) unless it is a file upload, which streams through
 * to the agent's own limits.
 */
const forward = ({ request, ref, route, path, search, principal, agent }: Forward) =>
  Effect.gen(function* () {
    const files = path === FILES || path.startsWith(`${FILES}/`)
    const limit = SENDS.has(route) ? SEND_BODY_LIMIT : JSON_BODY_LIMIT
    const body = files ? request.body : yield* bounded(request, limit)
    const headers = forwardedHeaders(request, ref, principal)
    // A streamed body needs `duplex` outside workerd (Node, the unit tests); workerd ignores it and its types omit it.
    // The agent's redirect (an outbound sign-in's callback, to Connections) goes to the browser: a followed one would
    // ask the agent for a page it does not serve.
    const init = { method: request.method, headers, body, duplex: 'half', redirect: 'manual' } as const
    const response = yield* attempt(() => agent.fetch(new Request(`https://agent${path}${search}`, init)))
    return secured(yield* withRetryAfter(response), ref)
  })

/**
 * An agent's redirect into the app, sent to the workspace's own pages (`/w/<slug>/…`, ADR 0089): an agent knows its
 * workspace by ID, never by the slug a member may change.
 */
const toWorkspacePages = (response: Response, slug: string, origin: string): Response => {
  const location = response.headers.get('location')
  if (location === null) return response
  const target = new URL(location, origin)
  if (target.origin !== origin || target.pathname.startsWith('/w/')) return response
  const headers = new Headers(response.headers)
  headers.set('location', `${origin}/w/${slug}${target.pathname}${target.search}${target.hash}`)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** One admitted member's request on its way to their workspace's agent, as its `/api/…` `path` and `search`. */
interface MemberForward {
  readonly request: Request
  readonly ref: string
  readonly route: string
  readonly path: string
  readonly search: string
  readonly person: Person
  readonly member: WorkspaceView
  readonly edge: Edge
}

/** Forwards a member's request with who they are, and sends the agent's redirects to the workspace's pages. */
const forwardMember = ({ request, ref, route, path, search, person, member, edge }: MemberForward) =>
  Effect.map(
    forward({
      request,
      ref,
      route,
      path,
      search,
      principal: {
        member: { user: person.id, role: member.role, name: memberName(person), shared: member.members > 1 },
      },
      agent: edge.agent(member.id),
    }),
    (response) => toWorkspacePages(response, member.slug, edge.origin),
  )

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
  readonly ownerNeeds: ReadonlyMap<string, Need>
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
        const person = yield* admitAccount(route, request, edge)
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

/** A request under a workspace's path, before its admission: where it goes, as its `/api/…` `path` and `search`. */
type WorkspaceRequest = Omit<MemberForward, 'person' | 'member'>

/**
 * An OAuth client's request on a workspace's path (ADR 0116): never the workspace account API, which is people's;
 * else admitted by its token (`admitClient`) and forwarded with its credential and the person it acts for.
 */
const forwardClient = (
  at: WorkspaceRequest,
  client: {
    readonly token: string
    readonly slug: string
    readonly inAccount: boolean
    readonly need: Need | undefined
  },
  known: (workspaceId: string) => void,
) =>
  Effect.gen(function* () {
    if (client.inAccount) return yield* new Forbidden({ reason: 'credential' })
    const admitted = yield* admitClient(at.request, at.edge, client.token, client.slug, client.need)
    known(admitted.workspace.id)
    const { credential, member } = admitted
    return yield* forward({
      ...at,
      principal: member === undefined ? { credential } : { credential, member },
      agent: at.edge.agent(admitted.workspace.id),
    })
  })

/**
 * A member's request of the workspace account API (members, apps), answered in the Worker; `route` the one it names.
 */
const answerWorkspaceAccount = (
  workspaceHttp: AccountHttp,
  at: WorkspaceRequest & { readonly facts: RequestFacts; readonly named: string | undefined },
  person: Person,
  member: WorkspaceView,
) =>
  Effect.gen(function* () {
    const { request, path, search, edge, facts } = at
    if (at.named === undefined) return yield* new NotFound({ what: 'route' })
    const body = yield* bounded(request, JSON_BODY_LIMIT)
    const admitted = new Request(`https://edge${path}${search}`, {
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
  })

const workspaceOf =
  ({ workspaceHttp, workspaceAccountRoute, ownerRoute, ownerNeeds, observed }: Built): EdgeHttp['workspace'] =>
  (request, edge) => {
    const url = new URL(request.url)
    const [, slug = '', path = url.pathname] = WORKSPACE_PATH.exec(url.pathname) ?? []
    const named = atPath(request, path, url.search)
    const inAccount = isWorkspaceAccountPath(path)
    const route = inAccount ? workspaceAccountRoute(named) : ownerRoute(named)
    const facts = { ...requestFacts(request, route ?? routeTemplate(path)), ref: refOf(request) }
    const token = bearerToken(request)
    const client = token === undefined ? undefined : { token, slug, inAccount, need: ownerNeeds.get(facts.route) }
    const at: WorkspaceRequest = { request, ref: facts.ref, route: facts.route, path, search: url.search, edge }
    const served = settle(request, facts, (known) =>
      Effect.gen(function* () {
        if (slug === '' || isAccountPath(path)) return yield* new NotFound({ what: 'route' })
        if (client !== undefined) return yield* forwardClient(at, client, known)
        const { person, workspace: member } = yield* admitMember(request, edge, { slug })
        known(member.id)
        if (!inAccount) return yield* forwardMember({ ...at, person, member })
        return yield* answerWorkspaceAccount(workspaceHttp, { ...at, facts, named: route }, person, member)
      }),
    )
    return Effect.provideContext(served, observed)
  }

/** Where a sign-in goes back to when its person is not in the workspace its state names: a page that says so. */
const SIGN_IN_ELSEWHERE = '/connect-elsewhere'

const signInOf =
  ({ ownerRoute, observed }: Built): EdgeHttp['signIn'] =>
  (request, edge) => {
    const url = new URL(request.url)
    const facts = { ...requestFacts(request, ownerRoute(request) ?? routeTemplate(url.pathname)), ref: refOf(request) }
    const served = settle(request, facts, (known) =>
      Effect.gen(function* () {
        const id = stateWorkspace(url.searchParams.get('state'))
        if (id === undefined) return yield* new NotFound({ what: 'workspace' })
        const admitted = yield* admitMember(request, edge, { id }).pipe(
          // expected: the person is no member of the sign-in's workspace. Its code goes to no agent (no login CSRF);
          // the page says where to finish it, without naming the workspace (ADR 0096).
          Effect.catchTag('NotFound', () => Effect.succeed(undefined)),
        )
        if (admitted === undefined)
          return secured(
            new Response(null, { status: 302, headers: { location: `${edge.origin}${SIGN_IN_ELSEWHERE}` } }),
            facts.ref,
          )
        const { person, workspace: member } = admitted
        known(member.id)
        return yield* forwardMember({
          request,
          ref: facts.ref,
          route: facts.route,
          path: url.pathname,
          search: url.search,
          person,
          member,
          edge,
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
    ownerNeeds: endpointAccess(OwnerApi),
  }
  return {
    account: accountOf(built),
    workspace: workspaceOf(built),
    signIn: signInOf(built),
    route: routeOf(built),
  }
})
