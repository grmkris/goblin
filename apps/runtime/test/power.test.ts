import { Type } from '@earendil-works/pi-ai'
import {
  type Harness,
  type HookApi,
  type LiveState,
  type Submission,
  type TaskId,
  defineExtension,
  defineTool,
} from '@earendil-works/pi-durable'
import { ROLE_POWER, type WorkspaceRole } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { type ReceiptInput, admitReceipt } from '../src/chats/receipts.ts'
import {
  AUTOMATION,
  type Effective,
  type GrantPower,
  type TurnPower,
  allows,
  effectivePower,
  intersect,
  powerOfAll,
  receiptPower,
  senderOf,
  senderPower,
} from '../src/grants/power.ts'
import { type AppError, failureOf } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { POWER_TEXT } from '../src/pi/asker.ts'
import { BACKGROUND, conversationId, entryId } from '../src/pi/context.ts'
import { PERSONA_DENIED_TOOLS, personaSelection } from '../src/pi/persona-selection.ts'
import { personaText } from '../src/pi/persona-turn.ts'
import { outsidePower, powerGuardExtension, toolsOf } from '../src/pi/power.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import type { RunTelemetry } from '../src/telemetry/events.ts'
import { TOOL_NEEDS, anyTurn, needOf } from '../src/pi/tool-needs.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { CLOSED } from '../src/setup/scope.ts'
import { Setups } from '../src/setup/service.ts'
import type { Boundary } from '../src/topics/boundary.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'
import { credential } from './grants-fixture.ts'
import { fake } from './fake.ts'
import { executeTool, inConversation } from './pi-tool.ts'

const grant = (parts: Partial<GrantPower> = {}): GrantPower => ({
  grantId: 'g1',
  level: 'write',
  extras: [],
  topics: 'all',
  connections: 'all',
  ...parts,
})

const HUB: Boundary = { topic: 1, hub: true }
const SEALED: Boundary = { topic: 2, hub: false }
const subagents = { subagents: () => true }

/** What a turn of `power` is offered where `boundary` is, of every tool the table knows, sorted. */
const offered = (power: TurnPower, boundary: Boundary): readonly string[] => {
  const effective = effectivePower(power, subagents, boundary, () => false)
  return Object.entries(TOOL_NEEDS)
    .filter(([, need]) => allows(effective, need))
    .map(([name]) => name)
    .toSorted()
}

/** The tools that need more than `read` of anyone (each tool's own name). */
const ORGANIZE = ['topic_rename', 'topic_archive', 'topic_setup', 'persona_create', 'persona_update']
const ROUTINE_TOOLS = ['routine_propose', 'routine_list', 'routine_pause']
const SOURCE_TOOLS = ['source_propose', 'source_routes', 'source_route']
const APPS = ['app_docs', 'app_inspect', 'app_call', 'app_build', 'app_rollback']

describe("a sender's power (ADR 0115)", () => {
  it("is a person's role's, a key's grant, a client's grant within its person's role, and an admin's for automation", () => {
    for (const role of ['owner', 'admin', 'member'] as const satisfies readonly WorkspaceRole[])
      expect(senderPower({ kind: 'person', role })).toMatchObject({ ...ROLE_POWER[role], server: false })
    expect(senderPower({ kind: 'key', grant: grant({ level: 'manage', extras: ['setup'] }) })).toEqual({
      level: 'manage',
      extras: ['setup'],
      server: true,
      topicLists: [],
      connectionLists: [],
    })
    // A client never does more than its person: a member's client with a manage grant writes, with inspect alone.
    expect(
      senderPower({ kind: 'client', role: 'member', grant: grant({ level: 'manage', extras: ['setup', 'inspect'] }) }),
    ).toMatchObject({ level: 'write', extras: ['inspect'], server: false })
    expect(senderPower({ kind: 'client', role: 'owner', grant: grant({ level: 'read' }) })).toMatchObject({
      level: 'read',
      extras: [],
    })
    expect(AUTOMATION).toMatchObject({ ...ROLE_POWER.admin, server: false })
  })

  it('names a list of Topics or connections by its grant, so a hub and a connection can be checked against it', () => {
    const listed = senderPower({ kind: 'key', grant: grant({ grantId: 'k', topics: 'list', connections: 'list' }) })
    expect(listed).toMatchObject({ topicLists: ['k'], connectionLists: ['k'] })
  })

  it("intersects a run's inputs: the least level, the extras all hold, a server's if any is, every list", () => {
    const owner = senderPower({ kind: 'person', role: 'owner' })
    const key = senderPower({ kind: 'key', grant: grant({ grantId: 'k', extras: ['inspect'], topics: 'list' }) })
    expect(intersect(owner, key)).toEqual({
      level: 'write',
      extras: ['inspect'],
      server: true,
      topicLists: ['k'],
      connectionLists: [],
    })
    expect(powerOfAll([])).toEqual(AUTOMATION)
    expect(powerOfAll([owner])).toEqual(intersect(AUTOMATION, owner))
  })

  it("reads the sender of a request: a key, a client and its person, a member's session, or no one", () => {
    const key = credential({ id: 'key-1', level: 'manage' })
    expect(senderOf({ credential: key })).toMatchObject({ kind: 'key', grant: { grantId: 'key-1', level: 'manage' } })
    const client = credential({ kind: 'client', id: 'c', level: 'write' })
    expect(senderOf({ credential: client, member: { role: 'admin' } })).toMatchObject({ kind: 'client', role: 'admin' })
    expect(senderOf({ credential: client })).toMatchObject({ kind: 'client', role: 'member' })
    expect(senderOf({ member: { role: 'member' } })).toEqual({ kind: 'person', role: 'member' })
    expect(senderOf({})).toBeUndefined()
  })

  it('reads a receipt made before powers were by its origin and role, failing closed for a key', () => {
    expect(receiptPower({ power: null, origin: 'key' })).toMatchObject({ level: 'read', extras: [], server: true })
    expect(receiptPower({ power: null, origin: 'owner', role: 'member' })).toMatchObject({ level: 'write' })
    expect(receiptPower({ power: null, origin: 'source' })).toEqual(AUTOMATION)
    expect(receiptPower({ power: 'not json', origin: 'key' })).toMatchObject({ server: true, level: 'read' })
  })
})

describe('what a turn is offered: senders × boundary (ADR 0115)', () => {
  const owner = senderPower({ kind: 'person', role: 'owner' })
  const admin = senderPower({ kind: 'person', role: 'admin' })
  const member = senderPower({ kind: 'person', role: 'member' })
  const writeKey = senderPower({ kind: 'key', grant: grant() })
  const manageKey = senderPower({ kind: 'key', grant: grant({ level: 'manage', extras: ['setup', 'routines'] }) })
  const reader = senderPower({ kind: 'client', role: 'owner', grant: grant({ level: 'read' }) })

  it('offers the owner and an admin everything in the hub, and all but the hub-only Source tools in a sealed Topic', () => {
    expect(offered(owner, HUB)).toEqual(Object.keys(TOOL_NEEDS).toSorted())
    expect(offered(admin, HUB)).toEqual(Object.keys(TOOL_NEEDS).toSorted())
    expect(offered(owner, SEALED)).toEqual(
      Object.keys(TOOL_NEEDS)
        .filter((name) => !SOURCE_TOOLS.includes(name))
        .toSorted(),
    )
  })

  it('offers a member writing, inspecting and apps, and no organizing, routines, Sources, servers or app builds', () => {
    const tools = offered(member, HUB)
    expect(tools).toEqual(expect.arrayContaining(['files_write', 'code_run', 'topic_create', 'diagnose', 'app_call']))
    for (const name of [...ORGANIZE, ...ROUTINE_TOOLS, ...SOURCE_TOOLS, 'mcp_request_server', 'app_build'])
      expect(tools, name).not.toContain(name)
  })

  it('offers a write key no routine, organizing or diagnose, and no apps outside the hub; in the hub, apps', () => {
    const sealed = offered(writeKey, SEALED)
    for (const name of [...ROUTINE_TOOLS, ...ORGANIZE, ...SOURCE_TOOLS, ...APPS, 'diagnose'])
      expect(sealed, name).not.toContain(name)
    expect(sealed).toEqual(expect.arrayContaining(['mcp_call', 'files_write', 'subagent_spawn', 'topic_create']))
    expect(offered(writeKey, HUB)).toEqual(expect.arrayContaining(['app_call', 'app_docs']))
  })

  it('gives a manage key with setup and routines what they open, and Sources only from the hub', () => {
    const sealed = offered(manageKey, SEALED)
    expect(sealed).toEqual(expect.arrayContaining([...ORGANIZE, ...ROUTINE_TOOLS, 'mcp_request_server']))
    expect(sealed).not.toContain('source_route')
    expect(offered(manageKey, HUB)).toEqual(expect.arrayContaining(SOURCE_TOOLS))
  })

  it('offers a read-level credential only what every turn may use', () => {
    expect(offered(reader, HUB)).toEqual(
      Object.entries(TOOL_NEEDS)
        .filter(([, need]) => anyTurn(need) || need.people === true)
        .filter(([, need]) => need.level === 'read')
        .map(([name]) => name)
        .toSorted(),
    )
  })

  it('takes the hub away from a turn a credential with a list of Topics sent, and its connections to its list', () => {
    const listed = senderPower({ kind: 'key', grant: grant({ grantId: 'k', topics: 'list', connections: 'list' }) })
    const effective: Effective = effectivePower(intersect(owner, listed), subagents, HUB, (id, connection) =>
      id === 'k' ? connection === 'notes' : false,
    )
    expect(effective).toMatchObject({ hub: false, people: false, topic: 1 })
    expect(effective.connection('notes')).toBe(true)
    expect(effective.connection('mail')).toBe(false)
    expect(effectivePower(owner, subagents, HUB, () => false).connection('mail')).toBe(true)
  })

  it('knows a native MCP tool as mcp_call, and no tool it was not told of', () => {
    expect(needOf('mycut__job_submit')).toEqual(TOOL_NEEDS.mcp_call)
    expect(needOf('later_tool')).toBeUndefined()
  })
})

/** Each run input of the fixture, by submission id: the request id Pi holds for it. */
const REQUESTS = new Map<number, string>([
  [1, 'op-owner'],
  [2, 'op-key'],
  [3, 'op-member'],
])

/** Who admitted each operation, with the power its sender had. */
const RECEIPTS: readonly (readonly [string, ReceiptInput])[] = [
  ['op-owner', { kind: 'send', origin: 'owner', power: senderPower({ kind: 'person', role: 'owner' }) }],
  ['op-key', { kind: 'send', origin: 'key', power: senderPower({ kind: 'key', grant: grant() }) }],
  ['op-member', { kind: 'send', origin: 'owner', power: senderPower({ kind: 'person', role: 'member' }) }],
]

const harness = fake<Harness>({
  submission: async (id) =>
    fake<Submission>({
      id,
      status: async () => ({
        id,
        conversationId: conversationId('41'),
        type: 'input',
        status: 'placed',
        entry: entryId(id),
        requestId: REQUESTS.get(id) ?? 'unknown',
      }),
    }),
})

/** The receipts above, Pi's harness, and a scope that puts session 41 in a sealed Topic and session 1 in the hub. */
const services = () => {
  const { db, close } = chatDatabase()
  for (const [operationId, receipt] of RECEIPTS)
    admitReceipt(db, { chat: '41', operationId, receipt, session: () => '41', now: 10 })
  return Layer.mergeAll(
    sqliteDb(db),
    Layer.succeed(PiSessions, fake<PiSessions['Service']>({ pi: Effect.succeed(harness) })),
    // The run recorder knows none of them here: each input's request id is Pi's.
    Layer.succeed(AgentInput, fake<AgentInputs>({ telemetry: fake<RunTelemetry>({ requestOf: () => undefined }) })),
    Layer.succeed(
      Setups,
      fake<Setups['Service']>({
        scope: (session) =>
          Effect.succeed(
            session === '99' ? CLOSED : { ...CLOSED, boundary: session === '1' ? HUB : SEALED, subagents: () => true },
          ),
      }),
    ),
    Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(close))),
  )
}

const run: RunProgram = async <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> => {
  // SAFETY: the power programs read only the services `services()` gives.
  const provided = Effect.provide(program, services()) as Effect.Effect<A, AppError>
  const exit = await Effect.runPromiseExit(provided)
  if (Exit.isSuccess(exit)) return exit.value
  throw failureOf(exit.cause)
}

/** A call's API in session `session` whose live run took `inputs`. */
const callIn = (session: number, ...inputs: number[]) => ({
  conversationId: conversationId(String(session)),
  snapshot: async (): Promise<LiveState | undefined> =>
    // SAFETY: Pi's ids are plain integers at runtime; the brands only type them.
    inputs.length === 0 ? undefined : { run: { taskId: 9 as TaskId, inputs: inputs as never } },
})

/** The guard's `beforeTool`, as Pi calls it for a call of `name`. */
const guarded = async (program: RunProgram, name: string, api: Pick<HookApi, 'conversationId' | 'snapshot'>) => {
  const [registration] = powerGuardExtension(program).hooks ?? []
  // SAFETY: the guard's one hook is ToolTask's, and its `beforeTool` reads the call's name, conversation and live run.
  const handlers = registration?.handlers as {
    readonly beforeTool: (call: { readonly name: string }, api: HookApi, context: unknown) => Promise<unknown>
  }
  // The guard reads only the conversation and its live run of the hook API.
  return handlers.beforeTool({ name }, fake<HookApi>(api), BACKGROUND)
}

/** A bridge whose runtime did not start: every program it is given fails. */
const failing: RunProgram = async () => Promise.reject(new Error('runtime down'))

const tool = (name: string, ran: string[] = []) =>
  defineTool({
    name,
    description: '',
    parameters: Type.Object({}),
    execute: async () => {
      ran.push(name)
      return { output: [{ type: 'text', text: 'ran' }] }
    },
  })

describe('the power guard at call time (ADR 0115)', () => {
  it("refuses routine_propose to a write key's turn, and to a run that batched it with the owner's", async () => {
    expect(await guarded(run, 'routine_propose', callIn(41, 1))).toBeUndefined()
    expect(await guarded(run, 'routine_propose', callIn(41, 2))).toEqual({ block: POWER_TEXT })
    expect(await guarded(run, 'routine_propose', callIn(41, 1, 2))).toEqual({ block: POWER_TEXT })
    expect(await guarded(run, 'topic_setup', callIn(41, 3))).toEqual({ block: POWER_TEXT })
  })

  it("refuses a hub's tool outside a hub for its boundary, and apps to a key's turn there but not in the hub", async () => {
    expect(await guarded(run, 'source_route', callIn(41, 1))).toEqual({
      block: expect.stringContaining('sealed'),
    })
    expect(await guarded(run, 'source_route', callIn(1, 1))).toBeUndefined()
    expect(await guarded(run, 'app_call', callIn(41, 2))).toEqual({ block: expect.stringContaining('sealed') })
    expect(await guarded(run, 'app_call', callIn(1, 2))).toBeUndefined()
  })

  it('runs a read every turn may make without reading power, never a tool it does not know, and fails closed', async () => {
    expect(await guarded(failing, 'search_chats', callIn(41, 2))).toBeUndefined()
    expect(await guarded(run, 'later_tool', callIn(41, 1))).toEqual({ block: expect.stringContaining('not one') })
    expect(await guarded(failing, 'files_write', callIn(41, 1))).toEqual({
      block: expect.stringContaining('could not be checked'),
    })
    // A session no chat owns may do nothing past a read.
    expect(await guarded(run, 'files_write', callIn(99, 1))).toEqual({ block: POWER_TEXT })
  })

  it("refuses a tool's own call before it runs when its turn's power does not reach it, behind the guard", async () => {
    const ran: string[] = []
    const extension = outsidePower(run, defineExtension({ name: 'x', tools: [tool('routine_propose', ran)] }))
    const [wrapped] = extension.tools ?? []
    if (wrapped === undefined) throw new Error('the tool is gone')
    expect(await executeTool(wrapped, {}, inConversation(41, callIn(41, 2)))).toMatchObject({ isError: true })
    expect(await executeTool(wrapped, {}, inConversation(41, callIn(41, 1)))).toMatchObject({
      output: [{ text: 'ran' }],
    })
    expect(ran).toEqual(['routine_propose'])
    const reads = defineExtension({ name: 'y', tools: [tool('search_chats')] })
    expect(outsidePower(run, reads)).toBe(reads)
  })

  it("lists every tool of the agent's once, whatever extension brought it", () => {
    const extensions = [
      defineExtension({ name: 'a', tools: [tool('mcp_call'), tool('files_list')] }),
      defineExtension({ name: 'b', tools: [tool('files_list'), tool('later_tool')] }),
    ]
    expect(toolsOf(extensions).map((each) => each.name)).toEqual(['mcp_call', 'files_list', 'later_tool'])
  })
})

describe("a Persona's fork keeps to its asker's power (ADR 0115)", () => {
  it("leaves out what its asker's power did not reach, keeping its native tools, and says when a server asked", () => {
    const denied = ['files_write', 'code_run', 'app_call']
    const picked = personaSelection({ tools: { remove: ['diagnose'] } }, [...PERSONA_DENIED_TOOLS, ...denied])
    expect(picked.tools).toEqual({
      remove: expect.arrayContaining(['diagnose', 'files_write', 'code_run', 'topic_create']),
    })
    const exact = personaSelection({ tools: ['mycut__job_submit', 'skill_activate', 'code_run'] }, denied)
    expect(exact.tools).toEqual(['mycut__job_submit', 'skill_activate'])
    expect(personaText({ name: 'Scout', role: '', instructions: '' }, 'server')).toContain(
      'A server the owner connected tagged @Scout',
    )
  })
})
