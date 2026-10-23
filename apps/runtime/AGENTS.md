# Runtime

Read the root instructions first. Owns the native Agent/Pi adapter, Effect services and their layers, the owner API's
handlers and edge, application storage, the MCP host and the auth boundary. Keep `PersonalAgent` thin; services do the
work. Never touch vendor tables. Check grants and resident authority before any outbound call. Alchemy modules never
enter the workerd bundle.

- **Owner API** ([ADR 0038](../../docs/adr/0038-typed-owner-api-served-by-the-agent.md)). An owner endpoint is an entry
  in its group in `packages/contracts/src/api` and a handler in its area's `api.ts`, served by the agent
  (`http/api/server.ts`) behind the Worker's edge (`http/api/edge.ts`) and owner admission (`OwnerAdmission`,
  `http/api/middleware.ts`). Never add a Durable Object RPC method or a Worker route for the owner. `/mcp` calls the
  owner API as its caller, a key or an OAuth client of the owner (ADR 0086, `ownerCall` in `inbound/client.ts`); the
  Worker's other callers (the hooks, file links) use the internal API (`@goblin/contracts/internal`, behind
  `InternalGate`, `internalCall`); the one RPC method left, `deleteAgentData`, returns an encoded
  result (`http/rpc.ts`), because Workers RPC drops error classes. Annotate an endpoint `EndpointAccess` (the level and
  extra it needs of a credential's grant, ADR 0114) only on purpose: it opens the endpoint to credentials (servers'
  keys and OAuth clients) over HTTP and `/mcp`, so it needs a tool in `inbound/tools.ts`'s registry and its handler
  must check the reach of what it touches with `grants/policy.ts` (`reaches*`, `claim`, `confineSetup`). Never for
  MCP tool grants, resident authority, files or keys.
- **Composition.** Services are `Context.Service` tags in `<area>/service.ts`, built by their area's layer in
  `layers/` over the core layer (`layers/core.ts`). `layers/index.ts` orders the start's steps, which are the boot
  contract (keep their order and every await), then the area layers. A stateful object is made once, by its layer,
  and shared as a service; programs use the services and compose. There are two ways into Effect, and programs use
  neither: code outside the runtime (the kits, alarms and apps engine `agent.ts` builds) runs programs through the
  bridge it is handed (`runtime/bridge.ts`), and a foreign callback wired inside a layer (the MCP SDK's auth provider
  and dispatch guards, the skills guard) through `promiseWith` (`runtime/boundary.ts`); `tools/graph.ts` closes both
  to the files it lists. The rules for both, locks and changes are [docs/agents/effect.md](../../docs/agents/effect.md).
- **Failures and logs.** Write lines only through `observability/logger.ts`; report a failure with `reportFailure` or
  `reportAndRecover` (`observability/report.ts`); record flow steps with `FlowEvents.record` or `withFlow`
  (`observability/flows.ts`). Never content (ADR 0024).
- **Locks, flights and changes.** Per-key mutual exclusion is `KeyedLock` (FIFO), held for admission only; keyed
  work that crosses a wait and that callers share (a token refresh, a connect, a move) is `SingleFlight`; a promise map
  or `#running` set is one of these written by hand. Tell other areas about a write through `Changes` with ids, not a
  listener set.
