import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Exit from 'effect/Exit'
import { afterEach, describe, expect, it } from 'vitest'
import { appServices } from '../src/agent-apps/ports.ts'
import { AppCodeError } from '../src/agent-apps/queue.ts'
import { Budget } from '../src/budget.ts'
import { Setups } from '../src/setup/service.ts'
import type { SetupScope } from '../src/setup/scope.ts'
import { Forbidden, ResidentInactive } from '../src/http/errors.ts'
import { McpConnections, Resident } from '../src/mcp/service.ts'
import type { McpCallOptions } from '../src/mcp/connections/types.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { Db } from '../src/runtime/db.ts'
import { appNotifySink } from '../src/storage/sources.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const complete = () => Effect.succeed('an answer')

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

/** A service of which a test fakes only the members the code under test calls. */
const part = <S>(service: Partial<S>): S =>
  // SAFETY: the powers call only the members each fake gives, and every test names the calls it expects.
  service as S

/** The owner's own chat on a messaging server: Notify me via, its words and operation id as whole values. */
const SINK = {
  connectionId: 'chat',
  tool: 'post_reply',
  arguments: { chat: 'dm', text: '{{text}}', op: '{{operationId}}' },
}

/** What a test changes about the world: authority, Notify me via, the server refusing, and what a call does first. */
type WorldOptions = {
  readonly resident?: boolean
  readonly sink?: typeof SINK
  readonly forbid?: boolean
  readonly status?: string
  readonly onCall?: (db: ReturnType<typeof durable>) => void
}

/**
 * The services an app's powers read, each the part these tests use, with what the tests change about them. The
 * server's tool runs the host's last-moment check (`authorize`) first and fails as it does; `refuse` answers an error.
 */
const world = (options: WorldOptions = {}) => {
  const calls: {
    readonly connectionId: string
    readonly name: string
    readonly args: Record<string, unknown>
    readonly authorized: boolean
  }[] = []
  const database = chatDatabase()
  open.push(database)
  const db = durable(database.db)
  if (options.sink !== undefined)
    db.insert(appNotifySink)
      .values({
        ...options.sink,
        id: 1,
        arguments: JSON.stringify(options.sink.arguments),
        policy: JSON.stringify({
          result: {
            accepted: { pointer: '/status', equals: 'sent' },
            retryable: { pointer: '/status', equals: 'retryable' },
            rejected: { pointer: '/status', equals: 'rejected' },
          },
        }),
        updatedAt: 1,
      })
      .run()
  const scope: SetupScope = {
    editable: true,
    server: () => true,
    tool: (_connectionId, name) => name !== 'off',
    skills: () => true,
    skill: () => true,
    subagents: () => true,
    app: () => true,
  }
  const services = Layer.mergeAll(
    Layer.succeed(
      Resident,
      part<Resident['Service']>({
        require: () =>
          options.resident === false ? Effect.fail(new ResidentInactive({ state: 'revoked' })) : Effect.void,
      }),
    ),
    Layer.succeed(
      Setups,
      part<Setups['Service']>({
        app: (session: string) => Effect.succeed(session !== 'no-apps'),
        scope: () => Effect.succeed(scope),
      }),
    ),
    Layer.succeed(Budget, part<Budget['Service']>({ require: () => Effect.void })),
    Layer.succeed(Db, db),
    Layer.succeed(
      McpConnections,
      part<McpConnections['Service']>({
        callTool: (connectionId: string, name: string, args: Record<string, unknown>, call?: McpCallOptions) =>
          Effect.gen(function* () {
            options.onCall?.(db)
            const check = yield* Effect.exit(call?.authorize ?? Effect.void)
            calls.push({ connectionId, name, args, authorized: Exit.isSuccess(check) })
            if (Exit.isFailure(check)) return yield* Effect.failCause(check.cause)
            if (options.forbid === true)
              return yield* new Forbidden({ reason: 'Owner approval required for this exact call' })
            return { content: [], isError: name === 'refuse', structuredContent: { status: options.status ?? 'sent' } }
          }),
      }),
    ),
  )
  /** The bridge's `run`: the program over the fakes. */
  const run: RunProgram = (program) =>
    // SAFETY: the powers' programs require only the services faked above.
    Effect.runPromise(program.pipe(Effect.provide(services)) as Effect.Effect<never>)
  return { powers: appServices(run, complete), calls }
}

describe("an agent app's powers over the agent's services", () => {
  it('call a tool once authority and the conversation allow it, and check again right before it leaves', async () => {
    const { powers, calls } = world()
    await powers.tool({ connectionId: 'notes', name: 'write', args: {}, session: '7' })
    expect(calls).toEqual([{ connectionId: 'notes', name: 'write', args: {}, authorized: true }])
    await expect(powers.tool({ connectionId: 'notes', name: 'off', args: {}, session: '7' })).rejects.toBeInstanceOf(
      Forbidden,
    )
    expect(calls).toHaveLength(1)
  })

  it('refuse an app a conversation switched off, and every power while authority lapsed', async () => {
    await expect(world().powers.authorizeCall('no-apps', 'tally')).rejects.toBeInstanceOf(Forbidden)
    await expect(world().powers.authorizeCall(undefined, 'tally')).resolves.toBeUndefined()
    await expect(world({ resident: false }).powers.complete('', 'hi', 10)).rejects.toBeInstanceOf(ResidentInactive)
    await expect(world().powers.complete('', 'hi', 10)).resolves.toBe('an answer')
  })

  it('say why a job waits', async () => {
    expect(await world({ resident: false }).powers.blocked()).toBe(
      'waiting for the owner (ResidentInactive — state: revoked)',
    )
    expect(await world().powers.blocked()).toBeUndefined()
  })
})

describe("an agent app's notify power through Notify me via (ADR 0070)", () => {
  it("fills the sink with the app's words as written and its operation id, checking again before it leaves", async () => {
    const { powers, calls } = world({ sink: SINK })
    await powers.notify('app-tally-op-1', '<b>Done</b> & dusted')
    expect(calls).toEqual([
      {
        connectionId: 'chat',
        name: 'post_reply',
        args: { chat: 'dm', text: '<b>Done</b> & dusted', op: 'app-tally-op-1' },
        authorized: true,
      },
    ])
  })

  it('says to set Notify me via while there is none, and nothing is sent', async () => {
    const { powers, calls } = world()
    await expect(powers.notify('op-1', 'hi')).rejects.toThrow('set Notify me via in Settings')
    expect(calls).toEqual([])
  })

  it("hands the sink's refusals back as the app's own error, and stops while authority lapsed", async () => {
    await expect(world({ sink: { ...SINK, tool: 'refuse' } }).powers.notify('op-1', 'hi')).rejects.toThrow(
      'Notify me via refused the message',
    )
    await expect(world({ sink: SINK, forbid: true }).powers.notify('op-1', 'hi')).rejects.toBeInstanceOf(AppCodeError)
    const lapsed = world({ sink: SINK, resident: false })
    await expect(lapsed.powers.notify('op-1', 'hi')).rejects.toBeInstanceOf(ResidentInactive)
    expect(lapsed.calls).toEqual([])
  })

  it.each(['retryable', 'rejected', 'unknown', 'unrecognised'])(
    'does not claim delivery for a %s result',
    async (status) => {
      await expect(world({ sink: SINK, status }).powers.notify('same-op', 'hi')).rejects.toBeInstanceOf(AppCodeError)
    },
  )

  it('refuses at the last moment a sink the owner changed on the way', async () => {
    const { powers, calls } = world({
      sink: SINK,
      onCall: (db) => void db.update(appNotifySink).set({ updatedAt: 2 }).run(),
    })
    await expect(powers.notify('op-1', 'hi')).rejects.toBeInstanceOf(AppCodeError)
    expect(calls).toEqual([{ connectionId: 'chat', name: 'post_reply', args: expect.any(Object), authorized: false }])
  })
})
