import { ChatId, MessageReceipt, SendMessage } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import type { SessionStore } from './session.ts'

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly ref: string | null,
  ) {
    const message =
      status === 401
        ? 'Sign in again to continue.'
        : status === 402
          ? 'Goblin Pro is required to send messages.'
          : status === 429
            ? 'Too many attempts. Please wait before trying again.'
            : status === 400
              ? 'Check your details and try again.'
              : 'Could not complete the request. Try again.'
    super(ref === null ? message : `${message} Reference: ${ref}`)
  }
}

/** Headers may combine Set-Cookie values. Only Better Auth's signed owner-session cookie is retained. */
export function sessionCookie(headers: Headers): string | undefined {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? '']
  for (const value of values) {
    const match = /(?:^|,\s*)((?:__Secure-)?better-auth\.session_token)=([^;,\s]*)/u.exec(value)
    if (match !== null) return match[2] === '' ? '' : `${match[1]}=${match[2]}`
  }
  return undefined
}

export type ApiOptions = {
  readonly origin: string
  readonly native: boolean
  readonly sessions: SessionStore
  readonly fetch?: typeof globalThis.fetch
}
const Session = Schema.NullOr(Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }))
const chatPath = (chat: string) => `/api/conversations/${Schema.decodeUnknownSync(ChatId)(chat)}`

/** Signed-cookie owner transport. It preserves the existing edge checks and never accepts MCP bearer tokens. */
export class GoblinApi {
  readonly #fetch: typeof globalThis.fetch
  #epoch = 0
  #stored = Promise.resolve()
  constructor(readonly options: ApiOptions) {
    const origin = new URL(options.origin)
    if (
      origin.origin !== options.origin ||
      origin.username !== '' ||
      origin.password !== '' ||
      (origin.protocol !== 'https:' &&
        !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '10.0.2.2'].includes(origin.hostname)))
    ) {
      throw new Error('Use an HTTPS Goblin origin, or a local development origin.')
    }
    this.#fetch = (options.fetch ?? globalThis.fetch).bind(globalThis)
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = apiUrl(this.options.origin, path)
    const epoch = this.#epoch
    const headers = new Headers(init.headers)
    const method = (init.method ?? 'GET').toUpperCase()
    headers.delete('authorization')
    headers.delete('cookie')
    headers.set('x-goblin-request', crypto.randomUUID().replaceAll('-', '').slice(0, 8))
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    if (method !== 'GET' && method !== 'HEAD') headers.set('x-goblin-csrf', '1')
    if (this.options.native) await this.#nativeHeaders(headers, epoch)
    const response = await this.#fetch(url, {
      ...init,
      method,
      headers,
      redirect: 'error',
      credentials: this.options.native ? 'omit' : 'include',
    })
    if (this.options.native && epoch === this.#epoch) {
      const cookie = sessionCookie(response.headers)
      if (cookie !== undefined) await this.#retain(cookie, epoch)
    }
    return response
  }

  async #nativeHeaders(headers: Headers, epoch: number): Promise<void> {
    headers.set('origin', this.options.origin)
    await this.#stored
    const cookie = await this.options.sessions.read()
    if (epoch !== this.#epoch) throw new Error('Session changed. Try again.')
    if (cookie !== null) headers.set('cookie', cookie)
  }

  #retain(cookie: string, epoch: number): Promise<void> {
    const write = this.#stored.then(async () => {
      if (epoch !== this.#epoch) return
      if (cookie === '') await this.options.sessions.clear()
      else await this.options.sessions.write(cookie)
    })
    this.#stored = write.catch(() => {
      // expected: the request reports storage failure; later sign-out must still clear the store.
    })
    return write
  }

  async #checked(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.request(path, init)
    if (!response.ok) throw new ApiFailure(response.status, response.headers.get('x-goblin-ref'))
    return response
  }
  async hasSession(): Promise<boolean> {
    const response = await this.request('/api/auth/get-session')
    if (response.status === 401) return false
    if (!response.ok) throw new ApiFailure(response.status, response.headers.get('x-goblin-ref'))
    return Schema.decodeUnknownSync(Session)(await response.json()) !== null
  }
  async sendCode(email: string, invite = ''): Promise<void> {
    await this.#checked('/api/auth/email-otp/send-verification-otp', json({ email, type: 'sign-in' }, invite))
  }
  async verifyCode(email: string, otp: string, invite = ''): Promise<void> {
    await this.#checked('/api/auth/sign-in/email-otp', json({ email, otp }, invite))
    if (!(await this.hasSession())) throw new Error('Sign-in did not establish a session. Request another code.')
  }
  async signOut(): Promise<void> {
    try {
      await this.#checked('/api/auth/sign-out', json({}))
    } finally {
      this.#epoch += 1
      await this.#retain('', this.#epoch)
    }
  }
  async snapshot(chat: string, signal: AbortSignal) {
    const response = await this.#checked(`${chatPath(chat)}/snapshot`, { signal })
    return Schema.decodeUnknownSync(Schema.JsonObject)(await response.json())
  }
  async submit(chat: string, message: SendMessage) {
    const payload = Schema.decodeUnknownSync(SendMessage)(message)
    const response = await this.#checked(`${chatPath(chat)}/messages`, {
      ...json(payload),
      headers: { 'content-type': 'application/json', 'x-goblin-operation': payload.operationId },
    })
    return Schema.decodeUnknownSync(MessageReceipt)(await response.json())
  }
  async stop(chat: string): Promise<void> {
    await this.#checked(`${chatPath(chat)}/stop`, json({}))
  }
  events(chat: string, signal: AbortSignal) {
    return this.#checked(`${chatPath(chat)}/events`, { signal, headers: { accept: 'text/event-stream' } })
  }
}

function json(body: object, invite = ''): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(invite === '' ? {} : { 'x-invite-code': invite }) },
    body: JSON.stringify(body),
  }
}

function apiUrl(origin: string, path: string): string {
  const target = new URL(path, origin)
  const allowed = path.startsWith('/api/') && target.origin === origin && target.pathname.startsWith('/api/')
  if (!allowed) throw new Error('Only the configured Goblin API can receive this session.')
  return target.toString()
}
