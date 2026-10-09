# Runtime

Read the root instructions first. Owns the native Agent/Pi adapter, Effect services and their layers, the owner API's
handlers and edge, application storage, the MCP host and the auth boundary. Keep `PersonalAgent` thin; services do the
work. Never touch vendor tables. Check grants and resident authority before any outbound call. Alchemy modules never
enter the workerd bundle.

- **Owner API** ([ADR 0038](../../docs/adr/0038-typed-owner-api-served-by-the-agent.md)). An owner endpoint is an entry
  in its group in `packages/contracts/src/api` and a handler in its area's `api.ts`, served by the agent
  (`http/api/server.ts`) behind the Worker's edge (`http/api/edge.ts`) and the owner gate (`http/api/middleware.ts`).
  Never add a Durable Object RPC method or a Worker route for the owner. The five RPC methods left return encoded
  results (`http/rpc.ts`), because Workers RPC drops error classes.
- **Composition.** Services are `Context.Service` tags in `<area>/service.ts`, built by their layer in `layers/` over
  the core layer (`layers/core.ts`); `layers/index.ts` orders the layers. `layers/legacy.ts` and `services.ts` are the
  legacy start, being retired: build new services in the area's layer. Run programs only through the bridge
  (`runtime/bridge.ts`), never `run` or `local` inside an Effect.
- **Failures and logs.** Write lines only through `observability/logger.ts`; report a failure with `reportFailure` or
  `reportAndRecover` (`observability/report.ts`); record flow steps with `FlowEvents.record`. Never content (ADR
  0024).
- **Locks and changes.** Per-key mutual exclusion is `KeyedLock` (FIFO), held for admission only; tell other areas
  about a write through `Changes` with ids, not a listener set.
