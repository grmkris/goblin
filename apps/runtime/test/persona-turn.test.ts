import type { FlowEvent } from '@goblin/contracts/telemetry'
import type { SubmissionRecord } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { Budget } from '../src/budget.ts'
import { type AppError, BudgetExhausted, Internal, failureOf } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { Resident } from '../src/mcp/service.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import type { Settlement } from '../src/personas/invocations.ts'
import { Invocations } from '../src/personas/service.ts'
import { refusalOf } from '../src/pi/persona-failures.ts'
import { askPhase } from '../src/pi/persona-turn.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { fake, unread } from './fake.ts'

type AskTask = Parameters<ReturnType<typeof askPhase>>[0]
type AskRuntime = Parameters<ReturnType<typeof askPhase>>[1]

const FORK = 7

/** What a turn's admission meets: each check, in order, either passes or fails with its error. */
type Checks = { readonly resident: readonly (AppError | undefined)[]; readonly budget?: AppError }

/**
 * The agent's way into its programs over the services a Persona turn's ask reaches: resident authority and the budget
 * (`checks`), the invocation rows it settles and the flows it records, both kept.
 */
function services(checks: Checks) {
  const settled: Settlement[] = []
  const flows: FlowEvent[] = []
  const residentChecks = [...checks.resident]
  const counts = { budget: 0 }
  const layer = Layer.mergeAll(
    Layer.succeed(
      Resident,
      fake<Resident['Service']>({
        require: () => {
          const next = residentChecks.shift()
          return next === undefined ? Effect.void : Effect.fail(next)
        },
      }),
    ),
    Layer.succeed(
      Budget,
      fake<Budget['Service']>({
        require: () => {
          counts.budget += 1
          return checks.budget === undefined ? Effect.void : Effect.fail(checks.budget)
        },
      }),
    ),
    Layer.succeed(
      Invocations,
      fake<Invocations['Service']>({
        settle: (_operation, _persona, settlement) => {
          settled.push(settlement)
          return Effect.succeed(true)
        },
      }),
    ),
    Layer.succeed(FlowEvents, FlowEvents.of({ record: (event) => Effect.sync(() => void flows.push(event)) })),
  )
  const run: RunProgram = async <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> => {
    // SAFETY: a Persona turn's ask reaches only resident authority, the budget, invocations and flows, all provided.
    const exit = await Effect.runPromiseExit(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
    if (Exit.isSuccess(exit)) return exit.value
    throw failureOf(exit.cause)
  }
  return { run, settled, flows, counts }
}

/**
 * A turn's runtime over a fork whose prompt is `asked` already or not: what it commits, what it submits, and whether it
 * slept.
 */
function runtimeOf(asked: boolean) {
  const states: unknown[] = []
  const submits: unknown[] = []
  const slept: number[] = []
  const tx = { submissionByRequest: async () => (asked ? fake<SubmissionRecord>({}) : undefined) }
  const runtime = fake<AskRuntime>({
    commit: async (change) => {
      const next = await change(fake<Parameters<typeof change>[0]>(tx), unread)
      if (next !== undefined) states.push(next)
    },
    conversation: async () =>
      fake<NonNullable<Awaited<ReturnType<AskRuntime['conversation']>>>>({
        submit: async (draft) => {
          submits.push(draft)
          return unread
        },
      }),
    now: () => 0,
    sleep: async (until) => void slept.push(until),
  })
  return { runtime, states, submits, slept }
}

const task = (retried = false) =>
  fake<AskTask>({
    input: {
      operationId: 'op-1',
      chat: '3',
      parent: fake<AskTask['input']['parent']>(3),
      order: 0,
      previous: null,
      previousPersona: null,
      persona: { id: 4, name: 'Echo', revision: 1, avatar: { glyph: 'E', hue: 1 }, role: '', instructions: '' },
    },
    state: fake<AskTask['state']>({
      checkpoint: { phase: 'ask', fork: fake<AskTask['state']['checkpoint']['fork']>(FORK), retried },
    }),
  })

describe("a Persona turn's ask", () => {
  it('waits for a prompt already in its fork, never asking for admission again (a restart after it was asked)', async () => {
    const { run, settled, counts } = services({ resident: [], budget: new BudgetExhausted({ limit: 1, resetsAt: 2 }) })
    const { runtime, states, submits } = runtimeOf(true)
    await askPhase(run)(task(), runtime, unread)
    expect(states).toEqual([{ status: 'running', checkpoint: { phase: 'await', fork: FORK } }])
    expect([counts.budget, submits.length, settled.length]).toEqual([0, 0, 0])
  })

  it('submits the prompt of an admitted turn once, then waits for it', async () => {
    const { run, settled } = services({ resident: [] })
    const { runtime, states, submits } = runtimeOf(false)
    await askPhase(run)(task(), runtime, unread)
    expect(submits).toMatchObject([{ type: 'input', requestId: 'persona:op-1:4' }])
    expect(states).toEqual([{ status: 'running', checkpoint: { phase: 'await', fork: FORK } }])
    expect(settled).toEqual([])
  })

  it('tries a transient refusal once more after a sleep, and gives up on the second, under its code', async () => {
    const transient = new Internal({ reason: 'x' })
    const first = services({ resident: [transient] })
    const once = runtimeOf(false)
    await askPhase(first.run)(task(), once.runtime, unread)
    expect(once.states).toEqual([{ status: 'running', checkpoint: { phase: 'ask', fork: FORK, retried: true } }])
    expect([once.slept.length, first.settled.length]).toEqual([1, 0])

    const second = services({ resident: [transient] })
    const again = runtimeOf(false)
    await askPhase(second.run)(task(true), again.runtime, unread)
    expect(second.settled).toEqual([{ state: 'failed', reason: 'unavailable' }])
    expect(second.flows).toMatchObject([{ flow: 'persona_answer', status: 'error', errorType: 'Internal' }])
    expect(again.states).toMatchObject([
      { status: 'terminal', outcome: { status: 'failed', error: { detail: { code: 'Internal' } } } },
    ])
    expect([again.slept.length, again.submits.length]).toEqual([0, 0])
  })

  it('ends at once on a refusal that stands, named by its code', async () => {
    const { run, settled, flows } = services({ resident: [], budget: new BudgetExhausted({ limit: 1, resetsAt: 2 }) })
    const { runtime, states, slept } = runtimeOf(false)
    await askPhase(run)(task(), runtime, unread)
    expect(settled).toEqual([{ state: 'failed', reason: 'budget' }])
    expect(flows).toMatchObject([{ status: 'error', errorType: 'BudgetExhausted' }])
    expect(states).toMatchObject([
      { status: 'terminal', outcome: { status: 'failed', error: { detail: { code: 'BudgetExhausted' } } } },
    ])
    expect(slept).toEqual([])
  })

  it('takes only a spent budget, a lapsed authority or no model endpoint as a refusal that stands', () => {
    expect(refusalOf(new BudgetExhausted({ limit: 1, resetsAt: 2 }))).toEqual({
      reason: 'budget',
      code: 'BudgetExhausted',
      final: true,
    })
    expect(refusalOf({ _tag: 'ResidentInactive' })).toEqual({
      reason: 'unavailable',
      code: 'ResidentInactive',
      final: true,
    })
    expect(refusalOf({ _tag: 'NoModelEndpoint' })).toEqual({
      reason: 'unavailable',
      code: 'NoModelEndpoint',
      final: true,
    })
    expect(refusalOf(new Internal({ reason: 'x' }))).toEqual({ reason: 'unavailable', code: 'Internal', final: false })
    expect(refusalOf(new Error('Network connection lost.'))).toEqual({
      reason: 'unavailable',
      code: 'Error',
      final: false,
    })
  })
})
