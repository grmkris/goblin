import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { requireBudget } from '../budget.ts'
import { Setups } from '../setup/service.ts'
import { Forbidden } from '../http/errors.ts'
import type { AgentServices } from '../layers/index.ts'
import { McpConnections, requireResident } from '../mcp/service.ts'
import { bound } from '../runtime/boundary.ts'
import type { Bridge, RunProgram } from '../runtime/bridge.ts'
import { Changes } from '../runtime/changes.ts'
import { notifySink, sendThroughSink, sinkRevision } from '../sources/notify.ts'
import { sinkOutcome } from '../sources/sink-result.ts'
import { appCompletion } from './completion.ts'
import type { AppPorts } from './engine.ts'
import { AppCodeError, appLock, problemText, thrownOf } from './queue.ts'

/**
 * What agent apps reach through their agent (ADR 0021): the owner's MCP tools, the cheap model and a message to the owner
 * through Notify me via (ADR 0070).
 */
export type AppServices = {
  readonly authorizeCall: (session: string | undefined, app: string) => Promise<void>
  /** One of the owner's MCP tools, called as the agent: the owner's exact grant is checked by the host, live. */
  readonly tool: (request: {
    readonly connectionId: string
    readonly name: string
    readonly args: Record<string, unknown>
    readonly session?: string | undefined
  }) => Promise<unknown>
  /** One completion on the deployment's cheap model, counted toward the owner's daily budget. */
  readonly complete: (system: string, prompt: string, maxTokens: number) => Promise<string>
  /** A message to the owner through Notify me via; `op` makes a retry send it once to a server that honours it. */
  readonly notify: (op: string, text: string) => Promise<void>
  /** Why the agent may not act on its own now (the owner's plan, or resident authority), or undefined if it may. */
  readonly blocked: () => Promise<string | undefined>
}

/** One completion on the cheap model, its tokens recorded against today's budget. */
export type AppCompletion = (
  system: string,
  prompt: string,
  maxTokens: number,
) => Effect.Effect<string, unknown, AgentServices>

/**
 * An app's message to the owner through Notify me via (ADR 0070), its words as written (the sink's server formats them):
 * resident authority first, and again with the sink right before the call leaves. With no sink, a sink that changed
 * on the way, a tool set to Ask first or a server that refuses, the app's own error says so.
 */
const notifyOwner = (op: string, text: string) =>
  Effect.gen(function* () {
    yield* requireResident
    const sink = yield* notifySink
    if (sink === undefined)
      return yield* Effect.fail(new AppCodeError('notify: the owner has not set Notify me via in Settings'))
    const revision = yield* sinkRevision(sink)
    const result = yield* sendThroughSink({ revision, text, operationId: op, timeout: 5000 }).pipe(
      Effect.catchTag('Forbidden', () =>
        Effect.fail(
          new AppCodeError(
            'notify: Notify me via may not send on its own now (its tool asks first, or the setting changed)',
          ),
        ),
      ),
    )
    switch (sinkOutcome(result, sink.result)) {
      case 'accepted':
        return
      case 'retryable':
        return yield* Effect.fail(new AppCodeError('notify: Notify me via asked for a retry'))
      case 'rejected':
        return yield* Effect.fail(new AppCodeError('notify: Notify me via refused the message'))
      case 'unknown':
        return yield* Effect.fail(new AppCodeError('notify: Notify me via returned an unknown delivery outcome'))
    }
  })

/**
 * The services an agent app's powers use, over the agent's own services. Each is a call from the app's isolate, so it
 * enters the runtime through `run`, which checks the owner's plan; then resident authority (and, where a conversation
 * asked, its switches). A lapsed one stops the app's power, never the owner. A power's failure reaches the app as it
 * was thrown.
 */
export function appServices(run: RunProgram, complete: AppCompletion): AppServices {
  const settled = async <A, E>(program: Effect.Effect<A, E, AgentServices>): Promise<A> => {
    const exit = await run(Effect.exit(program))
    if (Exit.isSuccess(exit)) return exit.value
    throw thrownOf(exit.cause)
  }
  return {
    authorizeCall: (session, app) =>
      settled(
        Effect.gen(function* () {
          yield* requireResident
          if (session !== undefined && !(yield* Setups.use((setups) => setups.app(session, app))))
            return yield* new Forbidden({ reason: 'app execution excluded here' })
        }),
      ),
    tool: ({ connectionId, name, args, session }) => {
      const authorize = Effect.gen(function* () {
        yield* requireResident
        if (session === undefined) return
        const scope = yield* Setups.use((setups) => setups.scope(session))
        if (!scope.tool(connectionId, name)) return yield* new Forbidden({ reason: 'app MCP tool excluded here' })
      })
      return settled(
        Effect.gen(function* () {
          yield* authorize
          // The host checks again right before the call leaves.
          const recheck = yield* bound(authorize)
          return yield* McpConnections.use((connections) =>
            connections.callTool(connectionId, name, args, { caller: 'model', timeout: 15_000, authorize: recheck }),
          )
        }),
      )
    },
    complete: (system, prompt, maxTokens) =>
      settled(requireResident.pipe(Effect.andThen(requireBudget), Effect.andThen(complete(system, prompt, maxTokens)))),
    notify: (op, text) => settled(notifyOwner(op, text)),
    blocked: () =>
      run(requireResident).then(
        () => undefined,
        // expected: a lapsed plan or authority is the answer; the job waits and its status says why
        (cause: unknown) => `waiting for the owner (${problemText(cause)})`,
      ),
  }
}

/**
 * What the agent object lends its apps from its bridge, made once with the engine (agent.ts): the powers' services,
 * the apps' lock (the runtime's KeyedLock) and `changed`, which tells the change bus `agent-apps.changed` without
 * waiting for it. Each enters the runtime through `run`.
 */
export function appPorts({ run }: Pick<Bridge, 'run'>): Pick<AppPorts, 'services' | 'lock' | 'changed'> {
  return {
    services: appServices(run, appCompletion),
    lock: appLock(run),
    changed: (app) =>
      void run(Changes.use((changes) => changes.publish('agent-apps.changed', { name: app }))).catch(
        // expected: the bridge reported why the runtime is down; the App follows the next change once it is up
        () => undefined,
      ),
  }
}
