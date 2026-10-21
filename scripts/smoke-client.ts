/**
 * Everything the smoke sends to one stage: the owner's cookie once signed in, a fresh `x-goblin-request` id, the CSRF
 * header on every write, and each answer's status and reference (`x-goblin-ref`, for `goblin lookup <ref>`) logged as a
 * step. Once signed in, a member's calls go under the owner's first workspace (`/w/<slug>/api/…`, ADR 0089), as the
 * app's do. The owner and account APIs go through their typed clients; Better Auth, `/mcp`, `/health` and the owner's
 * file bytes are plain requests.
 */
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Predicate from 'effect/Predicate'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { randomBytes } from 'node:crypto'
import { OwnerApi, WorkspaceAccountApi } from '../packages/contracts/src/api/index.ts'
import { readSession } from './session.ts'

/** One request the smoke sent: its status, and the reference the answer quoted (`goblin lookup <ref>`). */
export type Step = { readonly step: string; readonly status: number; readonly ref?: string }
export type OwnerClient = HttpApiClient.ForApi<typeof OwnerApi>
export type AccountClient = HttpApiClient.ForApi<typeof WorkspaceAccountApi>
/** A plain request: `owner: false` leaves out the session cookie, `csrf: false` the header every write carries. */
export type SendInit = RequestInit & { readonly owner?: boolean; readonly csrf?: boolean }

const JsonObject = Schema.Record(Schema.String, Schema.MutableJson)
const Workspaces = Schema.Array(Schema.Struct({ slug: Schema.String }))
/** A person's own paths, which no workspace prefix goes in front of. */
const PERSON_PATHS = ['/api/auth/', '/api/workspaces', '/api/client-errors']
const object = Schema.decodeUnknownSync(JsonObject)
const string = Schema.decodeUnknownSync(Schema.String)
const REQUEST_TIMEOUT_MS = 150_000

const isWrite = (method: string): boolean => method !== 'GET' && method !== 'HEAD'

/** What a failed typed call reports: its failure's tag, never its text. The steps hold its status and reference. */
const failureTag = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause)
  return Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag) ? failure._tag : 'Defect'
}

export class DevClient {
  readonly #url: URL
  readonly #steps: Step[]
  #cookie = ''
  /** The owner's first workspace's slug, once signed in. */
  #slug = ''
  readonly #owner: Effect.Effect<OwnerClient>
  readonly #account: Effect.Effect<AccountClient>

  constructor(url: URL, steps: Step[]) {
    this.#url = url
    this.#steps = steps
    const options = { baseUrl: url.origin, transformClient: this.#typed }
    this.#owner = HttpApiClient.make(OwnerApi, options).pipe(Effect.provide(FetchHttpClient.layer))
    this.#account = HttpApiClient.make(WorkspaceAccountApi, options).pipe(Effect.provide(FetchHttpClient.layer))
  }

  /** `path` as the owner's browser sends it: a member's `/api/…` path under their workspace once signed in. */
  #inWorkspace(path: string): string {
    const member = path.startsWith('/api/') && !PERSON_PATHS.some((prefix) => path.startsWith(prefix))
    return member && this.#slug !== '' ? `/w/${this.#slug}${path}` : path
  }

  get origin(): string {
    return this.#url.origin
  }

  /** One owner API call: its value, or `request_failed: <tag>`. `signal` cuts it short (150 s by default). */
  owner<A, E>(call: (api: OwnerClient) => Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
    return this.#run(Effect.flatMap(this.#owner, call), signal)
  }

  /** One workspace account API call (its inbound clients and keys), as `owner` runs one. */
  account<A, E>(call: (api: AccountClient) => Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
    return this.#run(Effect.flatMap(this.#account, call), signal)
  }

  async send(path: string, init: SendInit = {}): Promise<Response> {
    const { owner = true, csrf = true, ...rest } = init
    const method = rest.method ?? 'GET'
    const headers = new Headers(rest.headers)
    for (const [name, value] of Object.entries(this.#headers(method, owner, csrf))) headers.set(name, value)
    const response = await fetch(new URL(this.#inWorkspace(path), this.#url), {
      ...rest,
      headers,
      redirect: 'manual',
      signal: rest.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    this.#log(method, path, response.status, response.headers.get('x-goblin-ref') ?? undefined)
    return response
  }

  async json(path: string, init: SendInit = {}): Promise<typeof JsonObject.Type> {
    const response = await this.send(path, init)
    if (!response.ok) throw new Error(`request_failed: ${path.split('?')[0] ?? path}`)
    return object(await response.json())
  }

  /** Signs in with the saved session (`session.ts`) once it is this stage's and still the owner's. */
  async useSession(file: string, email: Redacted.Redacted): Promise<void> {
    const saved = readSession(file)
    if (saved.origin !== this.origin) throw new Error('session_origin_mismatch')
    this.#cookie = saved.cookie
    const session = await this.json('/api/auth/get-session')
    const owner = object(session['user'])
    if (string(owner['email']) !== Redacted.value(email)) throw new Error('session_owner_mismatch')
    if (Date.parse(string(object(session['session'])['expiresAt'])) <= Date.now()) throw new Error('session_expired')
    const [first] = Schema.decodeUnknownSync(Workspaces)(await (await this.send('/api/workspaces')).json())
    if (first === undefined) throw new Error('no_workspace')
    this.#slug = first.slug
  }

  /** What every request carries; the cookie is read when the request goes out, so it follows `useSession`. */
  #headers(method: string, owner: boolean, csrf: boolean): Readonly<Record<string, string>> {
    return {
      origin: this.#url.origin,
      'x-goblin-request': randomBytes(4).toString('hex'),
      ...(csrf && isWrite(method) ? { 'x-goblin-csrf': '1' } : {}),
      ...(owner && this.#cookie !== '' ? { cookie: this.#cookie } : {}),
    }
  }

  #log(method: string, path: string, status: number, ref: string | undefined): void {
    const step = `${method} ${path.split('?')[0] ?? path}`
    this.#steps.push({ step, status, ...(ref === undefined ? {} : { ref }) })
  }

  readonly #typed = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((request) => {
        const url = new URL(request.url)
        url.pathname = this.#inWorkspace(url.pathname)
        return HttpClientRequest.setHeaders(
          HttpClientRequest.setUrl(request, url.toString()),
          this.#headers(request.method, true, true),
        )
      }),
      HttpClient.tap((response) =>
        Effect.sync(() =>
          this.#log(
            response.request.method,
            new URL(response.request.url).pathname,
            response.status,
            response.headers['x-goblin-ref'],
          ),
        ),
      ),
    )

  async #run<A, E>(effect: Effect.Effect<A, E>, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)): Promise<A> {
    const exit = await Effect.runPromiseExit(effect, { signal })
    if (Exit.isSuccess(exit)) return exit.value
    throw new Error(`request_failed: ${failureTag(exit.cause)}`)
  }
}
