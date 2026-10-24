import { authFixtureRoute, fixtureAuth } from './auth-fixture.ts'
/** Native auth D1 + owner Agent fixture; test levers never enter the deployed Worker. */
import { Schema } from 'effect'
import runtime from '../../src/worker.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { refusal } from '../../src/http/api/render.ts'
import { toAppError } from '../../src/http/errors.ts'
import { PersonalAgent } from '../../src/agent.ts'
import { queueModel } from './queue-model.ts'
import { approvalsProbe } from './approvals-probe.ts'
import { requireUserSession } from '../../src/auth/index.ts'
import { workspacesOf } from '../../src/auth/workspaces.ts'
import { AppsMcpFixture } from './apps-mcp.ts'
import { permutePrimary, profileEnabled } from './primary-profile.ts'
import { chatSession } from '../../src/chats/directory.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import type { MovePhase } from '../../src/chats/mover.ts'
import { moveState, readRounds } from './move-probe.ts'
import { ownerSend } from './probe-reads.ts'
import { addUsage, utcDay } from '../../src/budget.ts'
import { BACKGROUND, conversationId } from '../../src/pi/context.ts'
import { leverChat, leverResponse } from './snapshot-lever.ts'
import type { PublishFetch } from '../../src/publish/deliver.ts'
import { PublishReceiver } from './publish-receiver.ts'

/** Tokens the `approvals/spent` lever adds to today: more than the owner stack's daily cap (`owner-stack.ts`). */
const SPENT_TOKENS = 1_000_000_000

export class OwnerAgent extends PersonalAgent {
  readonly #mcp = new AppsMcpFixture()
  /** The move boundary at which the next move stops the object (a restart then finishes the move). */
  #crashAt: MovePhase | undefined
  /** The move boundary at which the next move waits for `/test/move/resume`, and the phase it waits at. */
  #pauseAt: MovePhase | undefined
  #paused: { readonly phase: MovePhase; readonly resume: () => void } | undefined
  /** The published Events' webhooks, as this harness's receiver took them (`publish-receiver.ts`). */
  readonly #receiver = new PublishReceiver()
  protected override async moveBoundary(phase: MovePhase): Promise<void> {
    if (this.#pauseAt === phase) {
      this.#pauseAt = undefined
      const gate = Promise.withResolvers<void>()
      this.#paused = { phase, resume: gate.resolve }
      await gate.promise
      this.#paused = undefined
    }
    if (this.#crashAt !== phase) return
    this.#crashAt = undefined
    this.ctx.abort(`move restart after ${phase}`)
    // Hold the mover here until the reset lands: nothing past this boundary runs in the aborted instance, so the
    // restart always interrupts the move at `phase`.
    await new Promise<never>(() => undefined)
  }
  override async onStart(): Promise<void> {
    await super.onStart()
    if (profileEnabled(this.env)) await permutePrimary(this.ctx.storage, this.harness)
  }
  /** The published Events' webhooks go to the harness's own receiver, never the network. */
  protected override publishFetch(): PublishFetch {
    return this.#receiver.fetch
  }
  protected override modelStreams() {
    return queueModel(this).streams
  }
  override async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const chat = leverChat(path)
    if (chat !== undefined) return leverResponse(this.harness, this.ctx.storage, new URL(request.url), chat)
    if (path === '/test/primary-profile' && profileEnabled(this.env)) {
      const operationId = 'permuted-owner-proof'
      await ownerSend(this, '1', 'prove the owner primary binding', operationId)
      const session = chatSession(drizzle(this.ctx.storage), '1')
      const result = await this.harness.wait(operationId, { session })
      const messages = await this.harness.messages({ session: result.session })
      return Response.json({
        ...result,
        messages: messages.length,
        rootMessages: (await this.harness.messages({ session: '1' })).length,
      })
    }
    if (path === '/test/topics/sessions')
      return Response.json({ sessions: (await this.harness.sessions.list()).length })
    if (path.startsWith('/test/move/')) return this.#moveProbe(path, request)
    if (path === '/test/queue/held') return Response.json({ inputs: queueModel(this).held() })
    if (path === '/test/queue/seen') return Response.json({ requests: queueModel(this).requests() })
    if (path === '/test/retrieval/excerpts')
      return Response.json(
        this.ctx.storage.sql
          .exec(
            'SELECT entry_id AS entry, session_id AS session, chat_id AS chat, text FROM app_transcript_excerpts ORDER BY entry_id',
          )
          .toArray(),
      )
    if (path === '/test/queue/release') {
      const { input } = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.String }))(await request.json())
      return Response.json({ released: queueModel(this).release(input) })
    }
    if (path.startsWith('/test/power/')) return this.#powerProbe(path, request)
    if (path === '/test/publish/received') return Response.json(this.#receiver.received)
    if (path.startsWith('/test/approvals/')) return this.#approvalsLever(path, request)
    return super.onRequest(request)
  }
  /** The approvals' levers: the fixture's calls, today's spend past the cap and back, and the recovery read. */
  async #approvalsLever(path: string, request: Request): Promise<Response> {
    if (path === '/test/approvals/calls') return Response.json(this.#mcp.calls)
    // Today's tokens spent past the deployment's cap (`spent`), and given back (`unspent`).
    if (path === '/test/approvals/spent') return this.#spend(SPENT_TOKENS)
    if (path === '/test/approvals/unspent') return this.#spend(-SPENT_TOKENS)
    if (path === '/test/approvals/recovery')
      return Response.json(await approvalsProbe(this.ctx.storage, this.env.CREDENTIAL_KEY))
    return super.onRequest(request)
  }
  /** The power levers (ADR 0115): a stale tool filter, and a restart that forgets what this lifetime applied. */
  async #powerProbe(path: string, request: Request): Promise<Response> {
    if (path === '/test/power/stale') return this.#staleFilter(request)
    // The object restarts: the next request reconstructs it, its in-memory state (what it applied, ADR 0115) gone.
    if (path === '/test/power/restart') this.ctx.abort('power restart')
    return Response.json({ error: 'no such lever' }, { status: 404 })
  }
  /**
   * Clears a chat's Pi tool filter without this lifetime knowing, as a filter stored before a deploy (ADR 0115): what
   * the power guard must refuse at call time, and the chat's first turn after a restart puts right.
   */
  async #staleFilter(request: Request): Promise<Response> {
    const { chat } = Schema.decodeUnknownSync(Schema.Struct({ chat: Schema.String }))(await request.json())
    const session = chatSession(drizzle(this.ctx.storage), chat)
    const conversation = await (await this.harness.pi()).conversation(conversationId(session), BACKGROUND)
    await conversation?.configure({ tools: null }, BACKGROUND)
    return Response.json({ stale: chat })
  }
  /** Adds `tokens` to today's usage. */
  #spend(tokens: number): Response {
    const now = Math.floor(Date.now() / 1000)
    addUsage(drizzle(this.ctx.storage), utcDay(now).day, tokens, now)
    return Response.json({ tokens })
  }
  /** Move to thread probes (ADR 0034): arm a restart, read model attempts, rows and Pi sessions, time reads. */
  async #moveProbe(path: string, request: Request): Promise<Response> {
    if (path === '/test/move/crash' || path === '/test/move/pause') {
      const { phase } = Schema.decodeUnknownSync(Schema.Struct({ phase: Schema.Literals(['fork', 'head']) }))(
        await request.json(),
      )
      if (path === '/test/move/crash') this.#crashAt = phase
      else this.#pauseAt = phase
      return Response.json({ armed: phase })
    }
    if (path === '/test/move/paused') return Response.json({ phase: this.#paused?.phase ?? null })
    if (path === '/test/move/resume') {
      this.#paused?.resume()
      return Response.json({ resumed: true })
    }
    if (path === '/test/move/requests')
      return Response.json(
        queueModel(this)
          .requests()
          .map((seen) => seen.messages.flatMap((message) => (message.role === 'system' ? [] : [message.text]))),
      )
    if (path === '/test/move/latency') {
      const { chat, rounds } = Schema.decodeUnknownSync(Schema.Struct({ chat: Schema.String, rounds: Schema.Number }))(
        await request.json(),
      )
      return Response.json(await readRounds(this.harness, drizzle(this.ctx.storage), chat, rounds))
    }
    return Response.json(await moveState(this.harness, drizzle(this.ctx.storage)))
  }
  protected override mcpFetch(): typeof fetch {
    return this.#mcp.fetch
  }
}
/** The agent of the signed-in person's first workspace (ADR 0089): the one a test lever acts on. */
const leverAgent = async (input: Request, env: RuntimeEnv) => {
  const { person } = await requireUserSession(input, env)
  const [first] = await workspacesOf(env.AUTH_DB, person, new Date())
  if (first === undefined) throw new Error('no workspace')
  return env.AGENTS.getByName(first.id)
}

export default {
  async fetch(request: Request, env: RuntimeEnv) {
    const url = new URL(request.url)
    const input = new Request(new URL(url.pathname + url.search, env.APP_URL), request)
    // The deployed Worker sees its own host; the MCP endpoints check it (DNS-rebinding protection).
    input.headers.set('host', new URL(env.APP_URL).host)
    env = fixtureAuth(request, env)
    try {
      const authProbe = await authFixtureRoute(input, env)
      if (authProbe !== undefined) return authProbe
      // A chat's Pi snapshot or raw history (`snapshot-lever.ts`), from the signed-in person's own agent.
      if (leverChat(url.pathname) !== undefined) {
        return (await leverAgent(input, env)).fetch(`https://agent${url.pathname}${url.search}`)
      }
      if (url.pathname === '/__test/primary-profile') {
        return (await leverAgent(input, env)).fetch('https://agent/test/primary-profile')
      }
      if (url.pathname.startsWith('/__test/topics/')) {
        return (await leverAgent(input, env)).fetch(
          new Request(`https://agent/test/topics/${url.pathname.split('/').at(-1)}`, input),
        )
      }
      if (url.pathname === '/__test/retrieval/excerpts') {
        return (await leverAgent(input, env)).fetch('https://agent/test/retrieval/excerpts')
      }
      if (url.pathname.startsWith('/__test/move/')) {
        return (await leverAgent(input, env)).fetch(
          new Request(`https://agent/test/move/${url.pathname.split('/').at(-1)}`, input),
        )
      }
      if (url.pathname.startsWith('/__test/queue/')) {
        return (await leverAgent(input, env)).fetch(
          new Request(`https://agent/test/queue/${url.pathname.split('/').at(-1)}`, input),
        )
      }
      if (url.pathname.startsWith('/__test/power/')) {
        const name = url.pathname.split('/').at(-1)
        const agent = await leverAgent(input, env)
        // A restart ends the request it came in: the lever answers that it happened.
        if (name === 'restart')
          return await agent.fetch('https://agent/test/power/restart').then(
            () => Response.json({ restarted: false }),
            () => Response.json({ restarted: true }),
          )
        return agent.fetch(new Request(`https://agent/test/power/${name ?? ''}`, input))
      }
      if (url.pathname === '/__test/publish/received') {
        return (await leverAgent(input, env)).fetch('https://agent/test/publish/received')
      }
      if (url.pathname.startsWith('/__test/approvals/')) {
        return (await leverAgent(input, env)).fetch(`https://agent/test/approvals/${url.pathname.split('/').at(-1)}`)
      }
      return await runtime.fetch(input, env)
    } catch (cause) {
      // expected: the failure is the fixture's answer, in the envelope; toAppError reports an unexpected one
      return refusal(toAppError(cause), 'owner-fixture')
    }
  },
}
