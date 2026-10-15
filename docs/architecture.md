# Architecture

One Cloudflare Worker serves the web app and the API. Behind it, every user has their own `PersonalAgent` Durable
Object, named by their user ID: it runs Pi, holds that user's outbound MCP connections and credentials, and keeps
application state in its own SQLite. D1 holds Better Auth's account tables (users, sessions, inbound OAuth).

```mermaid
flowchart LR
  Browser --> Web[TanStack Start]
  Web --> Worker[Worker routes]
  Client[MCP client\nClaude Code, agents] -->|Bearer| Worker
  Worker --> Auth[(D1\nBetter Auth)]
  Worker -->|owner and internal APIs over fetch, one RPC| Agent[PersonalAgent DO]
  Agent --> Pi[(Pi tables)]
  Agent --> App[(app_* tables\nDrizzle)]
  Agent --> MCP[MCP servers the owner connects\nOAuth, refreshed in the DO]
  Agent --> Model[Model gateway]
```

## Areas

- [Worker](architecture/worker.md): routes the Worker serves and how a request reaches the agent.
- [The owner API](architecture/owner-api.md): the typed HttpApi the agent serves, and the browser data layer.
- [Per-call MCP approval](architecture/mcp-approvals.md): Ask first, held calls and their decisions.
- [Accounts](architecture/accounts.md): sign-in, sign-up, the landing and first-run Start.
- [The agent object](architecture/agent.md): PersonalAgent, Pi, conversations, threads and subagents.
- [Outbound MCP](architecture/outbound-mcp.md): connections, OAuth, grants and the MCP client.
- [Skills](architecture/skills.md): skills from MCP servers.
- [Chat blocks](architecture/chat-blocks.md): diagrams, charts and maps in replies.
- [MCP Apps host](architecture/mcp-apps.md): sandboxed server UIs.
- [Agent apps](architecture/agent-apps.md): apps goblin builds in Dynamic Workers.
- [Files](architecture/files.md): owner files in SQLite and R2.
- [Topics, Personas and memory](architecture/topics.md): Topics, Personas, organize receipts, retrieval and Topic memory.
- [Models](architecture/models.md): model calls and daily token usage.
- [Authority and inbound MCP](architecture/inbound-mcp.md): resident authority and goblin as an MCP server.
- [MCP Events and Telegram](architecture/events.md): Events subscriptions and the Telegram channel.
- [Sources](architecture/sources.md): any connection's events as the owner's own messages, routed to Topics and answered
  back.
- [Run ledger](architecture/observability.md): run ledger, logs, failures and inspection.
- [Storage](architecture/storage.md): D1, Durable Object SQLite and migrations.
- [Infrastructure and release](architecture/infrastructure.md): Alchemy stacks, stage origins, release and public source.
- [Routines and notices](architecture/routines.md): routine definitions, runs and notices.
