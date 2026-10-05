---
name: cloudflare-agents
description: Change the PersonalAgent Durable Object shell, its RPC surface, lifecycle adapters, or how the Worker reaches it.
---

# Cloudflare Agents in Purrable

`PersonalAgent extends Agent` and stays thin: each RPC method runs one Effect program on the object's
`ManagedRuntime` and returns an encoded result. Services do the work.

- One object per workspace owner, retaining the owner's user ID as its name. Resolve browser selection from the
  session and live D1 membership, never a request-supplied Agent name. Hooks/inbound MCP resolve verified ownership.
  Membership never grants owner RPC or resident renewal; shared execution uses trusted principal contexts, scope and
  the acting account's allowance (ADR 0014). An unconfigured Worker keeps shared access closed. Its SQLite is the
  durable boundary. Alchemy binds the class directly.
- Workers RPC drops custom error classes. Return `RpcResult` (`http/rpc.ts`) and let the Worker map the tagged error.
- Owner-facing methods renew resident authority; inbound-client methods do not.
- Inbound user authentication, the agent's resident authority and outbound MCP authorization are three separate
  things. Check them at the boundary that owns them.
- Never import Alchemy deployment code into workerd. Transactions and gates never span network or model work.

Before changing an API call, read the current [documentation](https://developers.cloudflare.com/agents/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.
