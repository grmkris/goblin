import type { Harness, LiveState, Submission, SubmissionId, TaskId } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { type ReceiptInput, admitReceipt } from '../src/chats/receipts.ts'
import { type AppError, Forbidden, NotFound, failureOf } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { Resident } from '../src/mcp/service.ts'
import { POWER_TEXT, adminOnly, inputOperation, powerAmong, requirePower } from '../src/pi/asker.ts'
import { BACKGROUND, conversationId, entryId, submissionId } from '../src/pi/context.ts'
import { organizeExtension } from '../src/pi/organize.ts'
import { outsidePower } from '../src/pi/power.ts'
import { routinesExtension } from '../src/pi/routines.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import type { RunTelemetry } from '../src/telemetry/events.ts'
import { sourcesExtension } from '../src/pi/sources.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { CLOSED } from '../src/setup/scope.ts'
import { Setups } from '../src/setup/service.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'
import { fake } from './fake.ts'
import { executeTool } from './pi-tool.ts'

/** Each run input of the fixture, by submission id: the request id Pi holds for it, none for the one without. */
const REQUESTS = new Map<number, string | undefined>([
  [1, 'op-owner'],
  [2, 'op-member'],
  [3, 'source-src_1-m1'],
  [4, 'routine-input:rr_1:1'],
  [5, 'persona:op-tag:7'],
  [6, undefined],
  [7, 'op-admin'],
  [8, 'op-key'],
  [9, 'persona:z:1'],
  [10, 'persona-resume:op-reply:12'],
  [11, 'persona:persona:z:1:1'],
])

/** Who admitted each operation, as the chat's receipts say. */
const RECEIPTS: readonly (readonly [string, ReceiptInput])[] = [
  ['op-owner', { kind: 'send', origin: 'owner', role: 'owner' }],
  ['op-admin', { kind: 'send', origin: 'owner', role: 'admin' }],
  ['op-member', { kind: 'send', origin: 'owner', role: 'member' }],
  ['op-key', { kind: 'send', origin: 'owner' }],
  ['op-tag', { kind: 'persona_ask', origin: 'owner', role: 'member' }],
  // A member's own message whose client chose an id shaped like a Persona turn's.
  ['persona:z:1', { kind: 'send', origin: 'owner', role: 'member' }],
  ['persona:persona:z:1:1', { kind: 'send', origin: 'owner', role: 'member' }],
  // A member's reply to a Persona's hold, which resumes its fork (`resumePersona`).
  ['op-reply', { kind: 'persona_reply', origin: 'owner', role: 'member' }],
  ['source-src_1-m1', { kind: 'source', origin: 'source' }],
  ['routine-input:rr_1:1', { kind: 'routine_input', origin: 'routine' }],
]

/** Pi's harness, asked only for the submissions behind a run's inputs: an input placed in session 41. */
const harness = fake<Harness>({
  submission: async (id) => {
    if (!REQUESTS.has(id)) return undefined
    const requestId = REQUESTS.get(id)
    return fake<Submission>({
      id,
      status: async () => ({
        id,
        conversationId: conversationId('41'),
        type: 'input',
        status: 'placed',
        entry: entryId(id),
        ...(requestId === undefined ? {} : { requestId }),
      }),
    })
  },
})

/** The receipts above in real SQLite, and Pi's harness. */
/** The inputs the run recorder saw admitted, by submission id: the owner's and the member's; Pi answers the rest. */
const RECORDED = new Map([
  ['1', 'op-owner'],
  ['2', 'op-member'],
])

/** Submissions Pi was asked for: a read the recorder already answers never reaches Pi's line. */
const piReads: number[] = []

const services = () => {
  const { db, close } = chatDatabase()
  for (const [operationId, receipt] of RECEIPTS)
    admitReceipt(db, { chat: '1', operationId, receipt, session: () => '41', now: 10 })
  const recorder = fake<RunTelemetry>({ requestOf: (submission) => RECORDED.get(submission) })
  const reading = fake<Harness>({
    submission: async (id, context) => {
      piReads.push(id)
      return harness.submission(id, context)
    },
  })
  return Layer.mergeAll(
    sqliteDb(db),
    Layer.succeed(PiSessions, fake<PiSessions['Service']>({ pi: Effect.succeed(reading) })),
    Layer.succeed(AgentInput, fake<AgentInputs>({ telemetry: recorder })),
    Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(close))),
  )
}

const ids = (...inputs: number[]): SubmissionId[] => inputs.map(submissionId)
/** Whether a member's role narrowed a run whose inputs are `inputs`: its power is a member's, `write` with `inspect`. */
const asked = (...inputs: number[]) =>
  powerAmong(ids(...inputs), BACKGROUND).pipe(
    Effect.map((power) => power.level === 'write'),
    Effect.provide(services()),
  )

/** A call in session 41 whose run took `inputs`; no run is live without them. */
const callIn = (...inputs: number[]) => ({
  conversationId: conversationId('41'),
  snapshot: async (): Promise<LiveState | undefined> =>
    // SAFETY: Pi's task ids are plain integers at runtime; the brand only types them.
    inputs.length === 0 ? undefined : { run: { taskId: 9 as TaskId, inputs: ids(...inputs) } },
})

describe("a member's turn is a member's power (unit, ADRs 0099, 0115)", () => {
  it.effect("is not one when the run took only an owner's or an admin's input", () =>
    Effect.gen(function* () {
      expect(yield* asked(1)).toBe(false)
      expect(yield* asked(1, 7)).toBe(false)
    }),
  )

  it.effect("is one when the run took a member's input, alone or batched with the owner's", () =>
    Effect.gen(function* () {
      expect(yield* asked(2)).toBe(true)
      expect(yield* asked(1, 2)).toBe(true)
      expect(yield* asked(7, 1, 2)).toBe(true)
    }),
  )

  it.effect('reads the request ids the run recorder saw without asking Pi, and asks Pi only for the rest', () =>
    Effect.gen(function* () {
      piReads.length = 0
      expect(yield* asked(1, 2)).toBe(true)
      expect(piReads).toEqual([])
      expect(yield* asked(1, 7)).toBe(false)
      expect(piReads).toEqual([7])
    }),
  )

  it.effect("counts a Source's and a routine's input as an admin's, and an app's as its receipt says", () =>
    Effect.gen(function* () {
      expect(yield* asked(3)).toBe(false)
      expect(yield* asked(4)).toBe(false)
      expect(yield* asked(8)).toBe(false)
      expect(yield* asked(3, 4, 8, 1)).toBe(false)
    }),
  )

  it.effect("is one when a member's client chose an operation id shaped like a Persona turn's", () =>
    Effect.gen(function* () {
      expect(yield* asked(9)).toBe(true)
      expect(yield* asked(1, 9)).toBe(true)
      // Unwrapping takes one level only; the id as admitted is what finds a nested one.
      expect(yield* asked(11)).toBe(true)
    }),
  )

  it.effect("makes a resumed Persona's turn the turn of whoever replied to its hold", () =>
    Effect.gen(function* () {
      expect(yield* asked(10)).toBe(true)
    }),
  )

  it.effect("makes a Persona's turn the turn of whoever tagged it", () =>
    Effect.gen(function* () {
      expect(yield* asked(5)).toBe(true)
      expect(inputOperation('persona:op:a:7')).toBe('op:a')
      expect(inputOperation('persona-resume:op-reply:12')).toBe('op-reply')
      expect(inputOperation('persona:op')).toBe('persona:op')
      expect(inputOperation('op-owner')).toBe('op-owner')
    }),
  )

  it.effect('refuses nothing for no live run, an unknown submission or one Pi holds no request id for', () =>
    Effect.gen(function* () {
      expect(yield* asked()).toBe(false)
      expect(yield* asked(6, 99)).toBe(false)
      yield* requirePower(callIn(), BACKGROUND, { extra: 'setup' }).pipe(Effect.provide(services()))
    }),
  )

  it.effect("refuses what a call asks beyond its tool's need through the call's live run, in words to relay", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        requirePower(callIn(1, 2), BACKGROUND, { extra: 'setup' }).pipe(Effect.provide(services())),
      )
      expect(refused).toMatchObject({ _tag: 'Forbidden', reason: 'power' })
      yield* requirePower(callIn(1), BACKGROUND, { extra: 'setup' }).pipe(Effect.provide(services()))
      const said = adminOnly('Personas')
      expect(said(refused)).toBe(`Changing Personas: ${POWER_TEXT}`)
      expect(said(new NotFound({ what: 'persona' }))).toContain('NotFound (what: persona)')
      expect(adminOnly('apps', () => 'build failed')(new Forbidden({ reason: 'key_setup' }))).toBe('build failed')
    }),
  )
})

/**
 * The agent's way into its programs (`runtime/bridge.ts`) over the fixture's services, current resident authority and
 * a chat in the hub: all a member's turn reaches, since each tool below refuses at its power check before it runs.
 */
const run: RunProgram = async <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> => {
  const resident = Layer.succeed(Resident, fake<Resident['Service']>({ require: () => Effect.void }))
  const scope = { ...CLOSED, boundary: { topic: 1, hub: true }, subagents: () => true }
  const setups = Layer.succeed(Setups, fake<Setups['Service']>({ scope: () => Effect.succeed(scope) }))
  const provided = Effect.provide(program, Layer.mergeAll(services(), resident, setups))
  // SAFETY: on a member's turn every program here fails at its power check, before it reads a service not provided.
  const exit = await Effect.runPromiseExit(provided as Effect.Effect<A, AppError>)
  if (Exit.isSuccess(exit)) return exit.value
  throw failureOf(exit.cause)
}

/** The tools as the agent selects them: each checks its turn's power before it runs (`outsidePower`). */
const TOOLS = [organizeExtension(run), routinesExtension(run), sourcesExtension(run)].flatMap(
  (extension) => outsidePower(run, extension).tools ?? [],
)

/**
 * Each tool that changes what the agent works with (ADR 0098), with arguments it accepts. `app_build` and `app_rollback`
 * load the apps engine, which needs workerd: the members case refuses them there (`integration/members-case.ts`).
 */
const ADMINS_TOOLS: Readonly<Record<string, unknown>> = {
  topic_create: { name: 'Orchard', setup: { mcpServers: [], skills: [], apps: [], subagents: false } },
  topic_setup: { topic: 'Personal', set: { mcpServers: 'all', skills: 'all', apps: 'all', subagents: true } },
  persona_create: { name: 'Scribe', role: 'Writes', instructions: 'Write well.' },
  persona_update: { persona: 'Scribe', role: 'Writes better' },
  routine_propose: {
    title: 'Morning brief',
    trigger: { kind: 'cron', expression: '0 8 * * *' },
    timezone: 'UTC',
    tellMe: { on: true, copy: false },
    handTo: { kind: 'none' },
  },
  routine_pause: { id: 'rt_1', revision: 1 },
  source_route: { source: 'src_1', key: 'k1', to: 'ignore' },
}

describe("the agent's tools on a member's turn (unit, ADRs 0099, 0115)", () => {
  it('refuse every change an admin makes, in words the model relays, before it is made', async () => {
    for (const [name, args] of Object.entries(ADMINS_TOOLS)) {
      const tool = TOOLS.find((candidate) => candidate.name === name)
      if (tool === undefined) throw new Error(`${name} missing`)
      // The tools read only the call's conversation, its call id and its live run (Pi's LiveDoc).
      const result = await executeTool(tool, args, { ...callIn(1, 2), callId: 'c1' })
      expect(result, name).toMatchObject({ isError: true })
      expect(JSON.stringify(result.output), name).toContain('takes an admin of this workspace')
    }
  })
})
