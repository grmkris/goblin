---
name: cloudflare-agents
description: Change the PersonalAgent Durable Object shell, the typed APIs and the RPC method it serves, lifecycle adapters, or how the Worker reaches it.
---

# Cloudflare Agents in goblin

`PersonalAgent extends Agent` and stays thin: services do the work. The owner reaches it through the typed owner API
on `onRequest` (`http/api/server.ts`, [ADR 0038](../../../docs/adr/0038-typed-owner-api-served-by-the-agent.md)), and
the Worker's other callers through the internal API on the same router; one RPC method remains, `deleteAgentData`.
Every program runs on the object's one `ManagedRuntime`, built lazily from `AgentLive` (`layers/index.ts`): code
outside the runtime enters it through the bridge (`runtime/bridge.ts`), a foreign callback wired inside a layer
through `promiseWith` (`runtime/boundary.ts`).

- One object per user, named by the authenticated user ID. The session user reaches only their own Agent;
  inbound MCP uses the verified bearer-token subject, and hooks check the user-bound token before object lookup.
  Never accept an Agent name from the request. Its SQLite is the durable boundary. Alchemy binds the class directly.
- An owner endpoint is an entry in its group (`packages/contracts/src/api/<group>.ts`) and a handler in its area's
  `api.ts`; never a new RPC method or Worker route. The Worker's edge (`http/api/edge.ts`) admits the request (Origin,
  the cookie session, CSRF on every write, a fresh plan, the 64 KiB body cap) and forwards it with an allowlisted set
  of headers, `x-goblin-ref` and its mark (`x-goblin-forwarded: owner`). Owner admission (`OwnerAdmission`,
  `http/api/middleware.ts`) checks the plan the agent keeps and renews resident authority, except on an endpoint
  annotated `RenewsResident: false`.
- What is not JSON in and out (the SSE streams, the owner's file bytes, the OAuth callback redirect) is an endpoint
  served through HttpApi's raw handlers, behind the same edge. One router (`AgentHttp`) serves the owner API and the
  internal API (`/internal`, `@goblin/contracts/internal`), which only the Worker calls on the stub: an inbound
  client's ask, recent read and inspection, and MCP Events. Its gate (`InternalGate`) refuses a request
  carrying the edge's mark and checks the plan the agent keeps unless the endpoint is `RequiresPlan: false`; it never
  renews resident authority. A new caller that is not the owner's browser gets an internal endpoint, never an RPC
  method.
- Workers RPC drops custom error classes. The one RPC method left (`deleteAgentData`) returns `RpcResult`
  (`http/rpc.ts`) and the Worker unwraps it; both APIs answer their error envelope instead.
- Run programs through the bridge, which `agent.ts` hands to the kits, alarms and apps engine it builds: `run` checks
  the plan, `local` does not (ledger, budget records, routine gates, diagnose), `exit` returns the exit. Only the files
  `tools/graph.ts` lists may import it, and never call it inside an Effect. What a program needs from the
  instance is in `AgentInput` (`runtime/input.ts`); build services in a layer, never at module level, and keep no
  module-level mutable state in the object's code. Work that outlives its caller is finite (`background()`,
  `observability/background.ts`): no loops or timers meant to outlive the object.
- Alarm and schedule callbacks are one-line delegations into their area's `wake.ts`; the Agents SDK calls them by name.
- Inbound user authentication, the agent's resident authority and outbound MCP authorization are three separate
  things. Check them at the boundary that owns them.
- Conversation routes carry stable logical chat ids. Resolve a chat through `Chats` before reaching Pi, and admit owner,
  inbound or Telegram operations through its recorded session. Nothing rebinds a chat: Move to thread forks a new
  Thread, and a running Pi turn never moves. Keep the Agent shell thin while services own this
  resolution and the application operation ledger. [ADR 0030](../../../docs/adr/0030-logical-chats-over-pi-sessions.md)
  defines intentionally Pi-keyed records and the unit/local workerd proof; the test-only permuted primary binding
  ships in no production class.
- Never import Alchemy deployment code into workerd. Transactions and gates never span network or model work.
- Typed decisions (ADR 0031) are the owner API's `decisions` group: `POST /api/decisions/:id` keeps the owner's first
  label, behind the edge's session and CSRF checks like every owner write; no endpoint takes an agent selector.

Before changing an API call, read the current [documentation](https://developers.cloudflare.com/agents/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.
