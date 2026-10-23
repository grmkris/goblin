import { runInput } from '@goblin/contracts'
import { Schema } from 'effect'
import { expect } from 'vitest'
import { callOwner } from '../owner-client.ts'
import {
  call,
  ownerFetch,
  person,
  showing,
  signedIn,
  snapshotText,
  workspaceOf,
  type Person,
} from './owner-requests.ts'
import { waitFor } from './until.ts'

const APP = 'https://goblin.test'
const CLOSED = { 'x-fixture-signup': 'closed' }

const Sent = Schema.Array(Schema.Struct({ invitation: Schema.Struct({ id: Schema.String }), mailed: Schema.Boolean }))
const Listed = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String, role: Schema.String }))

/**
 * A sign-in by emailed code while sign-up is closed, for `email`: its session, or the refusal of its code's send. No
 * first workspace is asked for, as `person` asks.
 */
async function signIn(base: string, email: string): Promise<{ readonly sent: number; readonly who?: Person }> {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:2`
  const headers = { origin: APP, 'content-type': 'application/json', 'cf-connecting-ip': ip, ...CLOSED }
  const sent = await ownerFetch(`${base}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  if (sent.status !== 200) return { sent: sent.status }
  const { code } = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(
    await (await ownerFetch(`${base}/__test/auth/mail?email=${encodeURIComponent(email)}`)).json(),
  )
  const session = await ownerFetch(`${base}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, otp: code }),
  })
  expect(session.status).toBe(200)
  const cookie = session.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const { user } = Schema.decodeUnknownSync(Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }))(
    await session.json(),
  )
  return { sent: 200, who: { userId: user.id, cookie, ip, email, workspace: '', slug: '' } }
}

/** `who`'s workspaces, as their browser lists them. */
const workspacesOf = async (base: string, who: Person) =>
  Schema.decodeUnknownSync(Listed)(await (await call(base, who, '/api/workspaces')).json())

/** How often `words` occur in main's snapshot as `who` reads it. */
const occurrences = async (url: string, who: Person, words: string) =>
  (await snapshotText(signedIn(url, who), '1')).split(words).length - 1

/** `who` says `input` in main, as their browser sends it; then, until one more answer there says `words`. */
async function answered(url: string, owner: Person, who: Person, input: string, words: string): Promise<void> {
  const before = await occurrences(url, owner, words)
  await callOwner(signedIn(url, who), (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: runInput('1', { input, operationId: crypto.randomUUID() }),
    }),
  )
  await waitFor(
    () => occurrences(url, owner, words),
    (now) => now > before,
    words,
    10_000,
  )
}

/** A message the scripted model answers by calling `persona_create` for a Persona named `name`. */
const personaCall = (name: string) =>
  `call persona_create {"name":"${name}","role":"Asked for","instructions":"Be brief."}`

/** The scripted model's answer to a call of a tool its turn's power does not reach: it is not offered (ADR 0115). */
const unavailable = (tool: string) => `Tool ${tool} is not available`

/**
 * The agent's own tools take an admin as the owner API does (ADRs 0099, 0115): a member's turn is not offered
 * `persona_create`, `app_build` or `app_rollback`, so the scripted model's calls of them change nothing, while a plain
 * Topic is made; on the owner's turn the Persona is made.
 */
async function agentToolsTakeAnAdmin(url: string, owner: Person, member: Person): Promise<void> {
  await answered(url, owner, member, personaCall('Askbot'), unavailable('persona_create'))
  const build = 'call app_build {"name":"askers","files":{"app.ts":"export {}"}}'
  await answered(url, owner, member, build, unavailable('app_build'))
  await answered(url, owner, member, 'call app_rollback {"app":"askers","release":"r1"}', unavailable('app_rollback'))
  // A plain Topic stays every member's to make (ADR 0098), on their turn too.
  const topic = `Asked topic ${crypto.randomUUID().slice(0, 8)}`
  await answered(url, owner, member, `call topic_create {"name":"${topic}"}`, 'done: Created topic')
  await answered(url, owner, owner, personaCall('Ownerbot'), 'done: Created persona @Ownerbot')
  const workspace = await workspaceOf(url, owner)
  expect(workspace.topics?.some((made) => made.name === topic)).toBe(true)
  const names = (workspace.personas ?? []).map((made) => made.name)
  expect(names).toContain('Ownerbot')
  expect(names).not.toContain('Askbot')
}

/**
 * Members and invitations (ADR 0093) through the Worker and the real auth D1: an owner invites an address while sign-up
 * is closed, which lets that address sign up and nothing else; the invited person gets no workspace of their own,
 * joins the owner's, works in its agent (the owner sees the Topic they made, and their message by name, ADR 0094) within
 * a member's role, on the agent's tools too (ADR 0099), and once removed reaches it no more.
 */
export async function membersCase(url: string): Promise<void> {
  const owner = await person(url)
  const email = `${crypto.randomUUID()}@fixture.test`
  expect((await signIn(url, `${crypto.randomUUID()}@fixture.test`)).sent).toBe(403)
  const invited = await call(url, owner, '/api/members/invitations', { emails: [email], role: 'member' })
  expect(invited.status).toBe(201)
  const [sent] = Schema.decodeUnknownSync(Sent)(await invited.json())
  expect(sent?.mailed).toBe(true)
  const id = sent?.invitation.id ?? ''
  const preview = await ownerFetch(`${url}/api/invitations/${id}`)
  expect(await preview.json()).toMatchObject({ email, state: 'pending', role: 'member' })

  const { who: guest } = await signIn(url, email)
  if (guest === undefined) throw new Error('the invited address could not sign in')
  expect(await workspacesOf(url, guest)).toEqual([])
  const accepted = await call(url, guest, `/api/invitations/${id}/accept`, {})
  expect(accepted.status).toBe(200)
  const [joined] = await workspacesOf(url, guest)
  expect(joined).toMatchObject({ id: owner.workspace, slug: owner.slug, role: 'member' })
  const member = { ...guest, workspace: owner.workspace, slug: owner.slug }

  const name = `Guest topic ${crypto.randomUUID().slice(0, 8)}`
  expect((await call(url, member, '/api/topics', { name, operationId: crypto.randomUUID() })).status).toBe(201)
  expect((await workspaceOf(url, owner)).topics?.some((topic) => topic.name === name)).toBe(true)
  // The workspace has two people now: each one's message carries who wrote it, by name and ID (ADR 0094).
  const words = `Hello from the guest ${crypto.randomUUID().slice(0, 8)}`
  await callOwner(signedIn(url, member), (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: runInput('1', { input: words, operationId: crypto.randomUUID() }),
    }),
  )
  const seen = await showing(signedIn(url, owner), '1', words)
  expect(seen).toContain(`[from member ${email.split('@')[0] ?? ''} · ${guest.userId}]`)
  const refused = await call(url, member, '/api/agent/resident', { enabled: false })
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({ error: { code: 'forbidden', reason: 'role' } })
  // What the agent works with takes an admin too (ADR 0098): a Persona, a Topic's guidance and its description, which
  // the agent reads as the Topic's purpose; a plain Topic does not.
  const persona = await call(url, member, '/api/personas', {
    name: 'Guestbot',
    avatar: { glyph: 'G', hue: 30 },
    role: 'A guest made it',
    instructions: 'Be brief.',
    operationId: crypto.randomUUID(),
  })
  expect(persona.status).toBe(403)
  const guided = await call(url, member, '/api/topics', {
    name: `Guided ${crypto.randomUUID().slice(0, 6)}`,
    instructions: 'Answer in haiku.',
    operationId: crypto.randomUUID(),
  })
  expect(await guided.json()).toMatchObject({ error: { code: 'forbidden', reason: 'role' } })
  const described = await call(url, member, '/api/topics', {
    name: `Described ${crypto.randomUUID().slice(0, 6)}`,
    description: 'Where the haiku go.',
    operationId: crypto.randomUUID(),
  })
  expect(described.status).toBe(403)
  await agentToolsTakeAnAdmin(url, owner, member)

  const removed = await ownerFetch(`${url}/w/${owner.slug}/api/members/${guest.userId}`, {
    method: 'DELETE',
    headers: { cookie: owner.cookie, origin: APP, 'x-goblin-csrf': '1', 'cf-connecting-ip': owner.ip },
  })
  expect(removed.status).toBe(200)
  expect((await call(url, member, '/api/topics')).status).toBe(404)
}
