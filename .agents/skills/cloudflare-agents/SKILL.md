---
name: cloudflare-agents
description: Change the PersonalAgent Durable Object shell, its RPC surface, lifecycle adapters, or how the Worker reaches it.
---

# Cloudflare Agents in goblin

`PersonalAgent extends Agent` and stays thin: each RPC method runs one Effect program on the object's
`ManagedRuntime` and returns an encoded result. Services do the work.

- One object per user, named by the authenticated user ID. The session user reaches only their own Agent;
  inbound MCP uses the verified bearer-token subject, and hooks check the user-bound token before object lookup.
  Never accept an Agent name from the request. Its SQLite is the durable boundary. Alchemy binds the class directly.
- Workers RPC drops custom error classes. Return `RpcResult` (`http/rpc.ts`) and let the Worker map the tagged error.
- Owner-facing methods renew resident authority; inbound-client methods do not.
- Inbound user authentication, the agent's resident authority and outbound MCP authorization are three separate
  things. Check them at the boundary that owns them.
- Conversation routes carry stable logical chat ids. Resolve a chat through `Chats` before reaching Pi, and admit owner,
  inbound or Telegram operations through its recorded session. A future epoch-fenced rebind closes that chat's SSE
  stream for a fresh snapshot; it never moves a running Pi turn. Keep the Agent shell thin while services own this
  resolution and the application operation ledger. [ADR 0030](../../../docs/adr/0030-logical-chats-over-pi-sessions.md)
  defines intentionally Pi-keyed records and the unit/local workerd proof; the test-only permuted primary binding
  ships in no production class.
- Never import Alchemy deployment code into workerd. Transactions and gates never span network or model work.

Before changing an API call, read the current [documentation](https://developers.cloudflare.com/agents/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- `POST /api/decisions/:id` requires the owner cookie session and strict browser CSRF. Agent RPC records the first label and publishes a durable highlight/thread-draft affordance; stale open proposals refuse confirmation. No Agent selector is accepted (ADR 0031).
