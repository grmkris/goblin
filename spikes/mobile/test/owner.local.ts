import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'
import { ownerStack } from '../../../apps/runtime/test/integration/owner-stack.ts'
import { GoblinApi, ApiFailure } from '../src/api.ts'
import { MobileConversation, type ConversationState } from '../src/conversation.ts'
import type { SessionStore } from '../src/session.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: `test_mobile_${process.pid}`,
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(ownerStack('goblinMobileHarness', 0)))
const Mail = Schema.Struct({ code: Schema.String })
const Identity = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })

function memorySession(): SessionStore {
  let cookie: string | null = null
  return {
    read: () => Promise.resolve(cookie),
    write: (value) => {
      cookie = value
      return Promise.resolve()
    },
    clear: () => {
      cookie = null
      return Promise.resolve()
    },
  }
}
function mobile(url: string) {
  const sessions = memorySession()
  const ip = `2001:db8:${crypto.randomUUID().slice(0, 4)}::1`
  const transport: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input.toString())
    const headers = new Headers(init?.headers)
    headers.set('cf-connecting-ip', ip)
    headers.set('connection', 'close')
    return fetch(`${url}${target.pathname}${target.search}`, { ...init, headers })
  }
  return new GoblinApi({ origin: 'https://goblin.test', native: true, sessions, fetch: transport })
}
async function signIn(api: GoblinApi, url: string) {
  const email = `${crypto.randomUUID()}@fixture.test`
  await api.sendCode(email)
  const mail = Schema.decodeUnknownSync(Mail)(
    await (await fetch(`${url}/__test/auth/mail?email=${encodeURIComponent(email)}`)).json(),
  )
  await api.verifyCode(email, mail.code)
  return Schema.decodeUnknownSync(Identity)(await (await api.request('/api/auth/get-session')).json()).user.id
}
async function plan(api: GoblinApi, url: string, userId: string) {
  const cookie = await api.options.sessions.read()
  if (cookie === null) throw new Error('Fixture session was not retained.')
  const response = await fetch(`${url}/__test/billing/override`, {
    method: 'POST',
    headers: { cookie, origin: 'https://goblin.test', 'content-type': 'application/json', 'x-goblin-csrf': '1' },
    body: JSON.stringify({ userId, dailyCredits: 1000 }),
  })
  expect(response.status).toBe(200)
}

harness.test(
  'mobile: real OTP, signed-cookie restore, Pro refusal, send/retry, live Pi stream, owner isolation and sign-out',
  stack.pipe(
    Effect.flatMap(({ url }) =>
      Effect.promise(async () => {
        const api = mobile(url)
        expect(await api.hasSession()).toBe(false)
        const userId = await signIn(api, url)
        expect(await api.hasSession()).toBe(true)
        const message = { input: 'hello mobile fixture', operationId: crypto.randomUUID() }
        await expect(api.submit('1', message)).rejects.toBeInstanceOf(ApiFailure)
        await plan(api, url, userId)
        const states: ConversationState[] = []
        const conversation = new MobileConversation(api, '1', (state) => states.push(state))
        conversation.reconnect()
        try {
          await expect.poll(() => states.at(-1)?.status, { timeout: 10_000 }).toBe('Connected')
          expect(await api.submit('1', message)).toMatchObject({ accepted: true, operationId: message.operationId })
          expect(await api.submit('1', message)).toMatchObject({ accepted: false, operationId: message.operationId })
          await expect
            .poll(() => states.at(-1)?.projection?.messages.some((item) => item.role === 'assistant'), {
              timeout: 15_000,
            })
            .toBe(true)
          expect(
            states.at(-1)?.projection?.messages.filter((item) => item.role === 'user' && item.text === message.input),
          ).toHaveLength(1)
          conversation.pause()
          conversation.reconnect()
          await expect.poll(() => states.at(-1)?.status).toBe('Connected')
          const other = mobile(url)
          await signIn(other, url)
          const snapshot = await other.snapshot('1', new AbortController().signal)
          expect(JSON.stringify(snapshot)).not.toContain(message.input)
          await other.signOut()
        } finally {
          conversation.pause()
        }
        await api.signOut()
        expect(await api.options.sessions.read()).toBeNull()
        expect(await api.hasSession()).toBe(false)
      }),
    ),
  ),
)
