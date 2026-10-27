/**
 * mysi trusted workloads (myapps ADR 0072), as goblin's post-deploy smoke and its prod alert use them (ADR 0128): this
 * CI job's own GitHub OIDC token, minted for mysi's token endpoint, is exchanged (RFC 7523 jwt-bearer) for a 15-minute
 * mysi token with no refresh, which calls mysi's `/mcp?codemode=off` tools. No stored key: the owner's workload policy
 * names this repository, its `ci.yml`, the ref and the job's environment, and links the one saved access it may use.
 * The token stays inside the call that made it, is never logged and never written anywhere.
 */
import * as Config from 'effect/Config'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'

export const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
/** mysi's production origin, where real mail and Telegram are. */
const DEFAULT_MYSI_ORIGIN = 'https://mysi.lol'

/** `MYSI_ORIGIN`, else mysi's own: unset or empty, as an unset GitHub variable arrives. */
export const mysiOrigin = Config.String('MYSI_ORIGIN').pipe(
  Config.withDefault(''),
  Config.map((origin) => (origin === '' ? DEFAULT_MYSI_ORIGIN : origin)),
)
const PROTOCOL = '2025-06-18'
const REQUEST_TIMEOUT_MS = 60_000

const JsonObject = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof JsonObject.Type
const object = Schema.decodeUnknownSync(JsonObject)
const decodeObject = Schema.decodeUnknownOption(JsonObject)
/** `value` as a JSON object, or an empty one when it is none. */
const objectOr = (value: unknown): JsonObject => Option.getOrElse(decodeObject(value), () => ({}))
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** What a workload needs: mysi's origin, the policy's client id (`wl_…`), and the job's OIDC request. */
export interface WorkloadConfig {
  readonly origin: string
  readonly clientId: string
  readonly requestUrl: string
  readonly requestToken: Redacted.Redacted
}

/**
 * Why a workload cannot run here, or nothing when it can: no client id configured (the owner has not made the policy
 * yet), or a job without `permissions: id-token: write` (no OIDC request), such as a local run.
 */
export function workloadMissing(config: WorkloadConfig): string | undefined {
  if (config.clientId === '') return 'no workload configured'
  if (config.requestUrl === '' || Redacted.value(config.requestToken) === '') return 'no OIDC token in this job'
  return undefined
}

/** The GitHub OIDC request for a token whose audience is mysi's token endpoint. */
export function oidcTokenUrl(requestUrl: string, origin: string): URL {
  const url = new URL(requestUrl)
  url.searchParams.set('audience', `${origin}/api/auth/oauth2/token`)
  return url
}

/** The jwt-bearer exchange's form: the assertion for the policy's client, for mysi's `/mcp` resource. */
export function exchangeForm(origin: string, clientId: string, assertion: string): URLSearchParams {
  return new URLSearchParams({ grant_type: JWT_BEARER, assertion, client_id: clientId, resource: `${origin}/mcp` })
}

/** The JSON-RPC body of a JSON answer or of an SSE one (its last `data:` line). */
export function rpcBody(contentType: string, body: string): JsonObject {
  if (!contentType.includes('text/event-stream')) return object(JSON.parse(body))
  const data = body.split('\n').findLast((line) => line.startsWith('data:'))
  return data === undefined ? {} : object(JSON.parse(data.slice('data:'.length)))
}

/** A tool result's value: its structured content, else its first text part read as JSON. */
export function toolValue(result: JsonObject): JsonObject {
  const structured = objectOr(result['structuredContent'])
  if (Object.keys(structured).length > 0) return structured
  const [first] = Array.isArray(result['content']) ? result['content'] : []
  const raw = text(objectOr(first)['text'])
  return raw === '' ? {} : objectOr(JSON.parse(raw))
}

const bounded = () => ({ redirect: 'manual' as const, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

async function platformToken(config: WorkloadConfig): Promise<string> {
  const response = await fetch(oidcTokenUrl(config.requestUrl, config.origin), {
    ...bounded(),
    headers: { authorization: `Bearer ${Redacted.value(config.requestToken)}` },
  })
  const value = text(objectOr(await response.json())['value'])
  if (response.status !== 200 || value === '') throw new Error(`workload_oidc_token_failed: ${response.status}`)
  return value
}

async function exchange(config: WorkloadConfig, assertion: string): Promise<string> {
  const response = await fetch(`${config.origin}/api/auth/oauth2/token`, {
    ...bounded(),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: exchangeForm(config.origin, config.clientId, assertion),
  })
  const body = objectOr(await response.json())
  const token = text(body['access_token'])
  // The refusal's error code names the problem (an unknown policy, claims that do not match); never its token.
  if (response.status !== 200 || token === '')
    throw new Error(`workload_exchange_refused: ${response.status} ${text(body['error']) || 'unknown'}`)
  return token
}

/** A workload signed in to mysi: tool calls by name, its token held only here. */
export interface Workload {
  readonly call: (tool: string, args: JsonObject) => Promise<JsonObject>
}

/** Signs this job in to mysi as the configured workload, or fails with a content-free reason. */
export async function openWorkload(config: WorkloadConfig): Promise<Workload> {
  const token = await exchange(config, await platformToken(config))
  let id = 0
  const rpc = async (method: string, params: JsonObject): Promise<JsonObject> => {
    const response = await fetch(`${config.origin}/mcp?codemode=off`, {
      ...bounded(),
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    const body = rpcBody(response.headers.get('content-type') ?? '', await response.text())
    const error = objectOr(body['error'])
    if (response.status !== 200 || Object.keys(error).length > 0)
      throw new Error(`workload_rpc_failed: ${method} ${response.status} ${JSON.stringify(error['code'] ?? null)}`)
    return objectOr(body['result'])
  }
  await rpc('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'goblin-smoke', version: '1' },
  })
  return {
    call: async (tool, args) => {
      const result = await rpc('tools/call', { name: tool, arguments: args })
      if (result['isError'] === true) throw new Error(`workload_tool_failed: ${tool}`)
      return toolValue(result)
    },
  }
}
