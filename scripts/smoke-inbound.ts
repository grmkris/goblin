import { createHash, randomBytes } from 'node:crypto'
import { presetFor } from '../packages/contracts/src/grants.ts'
import { Schema } from 'effect'
import type { DevClient } from './smoke-client.ts'

// The smoke's inbound MCP client (`smoke-dev.ts`), apart so the smoke itself stays readable.

const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof ObjectSchema.Type
const object = Schema.decodeUnknownSync(ObjectSchema)
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))
const string = Schema.decodeUnknownSync(Schema.String)

const REDIRECT_URI = 'http://127.0.0.1:9/callback'
/** The name the smoke's client registers with, which its messages carry as their author. */
export const SMOKE_CLIENT_NAME = 'goblin-smoke'
/** Personal's Conversation, the agent's main chat (ADR 0086), where the smoke's client talks: chat 1. */
export const MAIN_CHAT = '1'
/** The protocol revision whose requests may declare the Tasks extension (ADR 0119), and that extension. */
const MODERN = '2026-07-28'
const TASKS = 'io.modelcontextprotocol/tasks'

export const base64url = (bytes: Buffer): string => bytes.toString('base64url')

/** A fresh operation id for one of the smoke's writes. */
export const operationId = (step: string): string => `smoke-${step}-${base64url(randomBytes(9))}`

export /** An inbound MCP client: dynamic registration, owner consent, PKCE code exchange, then Streamable HTTP calls. */
class InboundClient {
  readonly #dev: DevClient
  readonly clientId: string
  #token = ''
  #nextId = 1
  constructor(dev: DevClient, clientId: string) {
    this.#dev = dev
    this.clientId = clientId
  }

  static async register(dev: DevClient): Promise<InboundClient> {
    const registered = await dev.json('/api/auth/oauth2/register', {
      method: 'POST',
      owner: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: SMOKE_CLIENT_NAME,
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
    return new InboundClient(dev, string(registered['client_id']))
  }

  async authorize(): Promise<void> {
    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const resource = `${this.#dev.origin}/mcp`
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid offline_access goblin',
      state: base64url(randomBytes(16)),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
    })
    const authorize = await this.#dev.send(`/api/auth/oauth2/authorize?${query.toString()}`)
    const location = authorize.headers.get('location') ?? ''
    if (!location.startsWith('/consent?')) throw new Error('consent_redirect_missing')
    // As the consent page does (ADRs 0097, 0114): its grant writes and inspects in the owner's one workspace, so its
    // calls name none.
    const terms = { ...presetFor(SMOKE_CLIENT_NAME, [this.#dev.workspaceId]), extras: ['inspect' as const] }
    await this.#dev.person((api) => api.grants.clientGrant({ params: { clientId: this.clientId }, payload: { terms } }))
    const consent = await this.#dev.json('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: location.slice('/consent?'.length) }),
    })
    const code = new URL(string(consent['url'])).searchParams.get('code')
    if (code === null) throw new Error('authorization_code_missing')
    const token = await this.#dev.json('/api/auth/oauth2/token', {
      method: 'POST',
      owner: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        resource,
      }).toString(),
    })
    this.#token = string(token['access_token'])
  }

  /** One JSON-RPC call; the stateless server answers with JSON or a one-event SSE stream. */
  async rpc(method: string, params: JsonObject = {}): Promise<{ status: number; result?: JsonObject }> {
    const response = await this.#dev.send('/mcp', {
      method: 'POST',
      owner: false,
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
    })
    if (!response.ok) return { status: response.status }
    const body = await response.text()
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? (body
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .at(-1)
          ?.slice('data: '.length) ?? '{}')
      : body
    const message = object(JSON.parse(payload))
    if (message['error'] !== undefined) throw new Error(`mcp_rpc_error: ${method}`)
    return { status: response.status, result: object(message['result']) }
  }

  /**
   * One request on the 2026-07-28 protocol, by hand: the SDK's client refuses a result type it does not know, and a task
   * (ADR 0119) is one. Its `_meta` envelope declares the Tasks extension when `tasks`; `name` is what `Mcp-Name` mirrors.
   * The answer's result or its error, as sent.
   */
  async modern(
    method: string,
    params: JsonObject,
    options: { readonly tasks: boolean; readonly name?: string },
  ): Promise<{ readonly result?: JsonObject; readonly error?: JsonObject }> {
    const response = await this.#dev.send('/mcp', {
      method: 'POST',
      owner: false,
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN,
        'mcp-method': method,
        ...(options.name === undefined ? {} : { 'mcp-name': options.name }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.#nextId++,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: SMOKE_CLIENT_NAME, version: '1' },
            'io.modelcontextprotocol/clientCapabilities': options.tasks ? { extensions: { [TASKS]: {} } } : {},
          },
        },
      }),
    })
    const body = await response.text()
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? (body
          .split('\n')
          .findLast((line) => line.startsWith('data: '))
          ?.slice('data: '.length) ?? '{}')
      : body
    const message = object(JSON.parse(payload))
    return {
      ...(message['result'] === undefined ? {} : { result: object(message['result']) }),
      ...(message['error'] === undefined ? {} : { error: object(message['error']) }),
    }
  }

  async tool(name: string, args: JsonObject): Promise<JsonObject> {
    const { result } = await this.rpc('tools/call', { name, arguments: args })
    if (result === undefined) throw new Error(`inbound_tool_failed: ${name}`)
    const [first] = objects(result['content'])
    // A tool error is goblin's encoded error: report its tag (`BudgetExhausted`), never the rest of what it says.
    const tag = /"_tag":"(\w+)"/u.exec(string(first?.['text'] ?? ''))?.[1]
    if (result['isError'] === true) throw new Error(`inbound_tool_failed: ${name}: ${tag ?? 'unknown'}`)
    return object(JSON.parse(string(first?.['text'])))
  }

  /**
   * A message into main and how it stands once settled, or after 100 s: `conversation_send`, then
   * `conversation_send_status` every 2 s, as a client without the Tasks extension follows its send (ADR 0119).
   */
  async ask(input: string): Promise<JsonObject> {
    const id = operationId('inbound')
    await this.tool('conversation_send', { chat: MAIN_CHAT, message: { input, operationId: id } })
    const deadline = Date.now() + 100_000
    let status = await this.tool('conversation_send_status', { chat: MAIN_CHAT, operationId: id })
    while ((status['status'] === 'queued' || status['status'] === 'working') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      status = await this.tool('conversation_send_status', { chat: MAIN_CHAT, operationId: id })
    }
    return status
  }

  /** Every entry of `chat`, oldest first: `conversation_entries` paged to its end. */
  async entries(chat: string): Promise<JsonObject[]> {
    const all: JsonObject[] = []
    let after = 0
    for (;;) {
      const page = await this.tool('conversation_entries', { chat, after, limit: 100 })
      all.push(...objects(page['entries']))
      if (page['more'] !== true || typeof page['next'] !== 'number') return all
      after = page['next']
    }
  }
}
