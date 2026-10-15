import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { AppError } from '../http/errors.ts'
import { Events } from '../mcp/service.ts'
import { FlowEvents } from '../observability/flows.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { sourceEngine } from '../sources/engine.ts'
import { type PortServices, sourcePorts } from '../sources/ports.ts'
import {
  SOURCE_HANDLER,
  confirmSource,
  consumeSourceEvent,
  pauseSource,
  proposeSource,
  refuseSource,
  removeSource,
  resumeSource,
  routeSource,
  sourceRoutes,
  sourcesList,
  undoSourceRoute,
  wakeSources,
} from '../sources/program.ts'
import { Sources } from '../sources/service.ts'
import type { SourceDelivery } from '../sources/types.ts'

/** Everything the Sources' programs read, which their service captures once from its layer. */
type ProgramServices = Effect.Services<
  [
    typeof sourcesList,
    ReturnType<typeof sourceRoutes>,
    ReturnType<typeof proposeSource>,
    ReturnType<typeof confirmSource>,
    ReturnType<typeof refuseSource>,
    ReturnType<typeof routeSource>,
    ReturnType<typeof undoSourceRoute>,
    ReturnType<typeof pauseSource>,
    ReturnType<typeof resumeSource>,
    ReturnType<typeof removeSource>,
    ReturnType<typeof consumeSourceEvent>,
    ReturnType<typeof wakeSources>,
  ][number]
>

/** One answer's delivery through a Source as a flow (ADR 0024): its turn, how many pieces it took, and its failure. */
const deliveryFlow = (delivery: SourceDelivery) =>
  FlowEvents.record({
    flow: 'source_delivery',
    via: 'mcp',
    actor: 'agent',
    operationId: delivery.operationId,
    count: delivery.pieces,
    status: delivery.errorType === undefined ? 'ok' : 'error',
    ...(delivery.errorType === undefined ? {} : { errorType: delivery.errorType }),
  })

/**
 * The owner's Sources (ADR 0066), after the routines whose notices they post: the engine, made once here over the
 * agent's database with its own permit, the ports over the agent's services, and the `source-wake` handler registered
 * with Events before the agent runs anything. Each method runs its program with the services captured here.
 */
export const SourcesLive: Layer.Layer<Sources, never, ProgramServices | PortServices | FlowEvents> = Layer.effect(
  Sources,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const engine = yield* sourceEngine({ db: yield* Db, telemetry: input.telemetry, wake: input.scheduleSources })
    const ports = yield* sourcePorts
    const context = yield* Effect.context<ProgramServices | FlowEvents>()
    const provided = <A>(program: Effect.Effect<A, AppError, ProgramServices>) =>
      Effect.provideContext(program, context)
    const delivered = (delivery: SourceDelivery) => Effect.provideContext(deliveryFlow(delivery), context)
    yield* (yield* Events).register(SOURCE_HANDLER, (event) => provided(consumeSourceEvent(engine, ports, event)))
    return Sources.of({
      list: provided(sourcesList),
      routes: (id) => provided(sourceRoutes(id)),
      propose: (proposal, by) => provided(proposeSource(proposal, by)),
      confirm: (id, revision) => provided(confirmSource(engine, ports, id, revision)),
      refuse: (id, revision) => provided(refuseSource(id, revision)),
      route: (id, pick, by) => provided(routeSource(engine, ports, id, pick, by)),
      undo: (receipt) => provided(undoSourceRoute(engine, receipt)),
      pause: (id) => provided(pauseSource(id)),
      resume: (id) => provided(resumeSource(engine, ports, id)),
      remove: (id) => provided(removeSource(id)),
      wake: provided(wakeSources(engine, ports, delivered)),
    })
  }),
)
