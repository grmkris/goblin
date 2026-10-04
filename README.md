# Purrable

A resident personal agent on Cloudflare, using native Agents/PiHarness, Pi Durable, Effect, Alchemy and MCP.

```sh
bun install --frozen-lockfile
mkdir -p .local
cp .env.example .local/local.env
chmod 600 .local/local.env
bun dev
bun run check
```

Set your owner email and replace the two local secrets before starting. Local model calls inherit `CLIPROXY_API_KEY`.
The [development guide](docs/development.md) covers owner setup, deployment and the manual smoke command.

The [implementation record](docs/archive/2026-10-04-initial-slice/implementation.md) records checkpoint status and actual evidence. An installed
framework or a local test does not establish live Cloudflare acceptance.
The [handoff](docs/archive/2026-10-04-initial-slice/handoff.md) summarizes the directory tree, pinned composition, verification and continuation boundaries.

Pi owns agent transcripts/tasks; application metadata stays in application-owned Durable Object SQLite tables.
The browser projects committed state through AG-UI and hosts sandboxed MCP Apps over authorized MCP connections.

Deployment uses Alchemy only. The retained dev stage uses Railway LiteLLM with a dedicated bounded virtual key.
Production promotion, Telegram/My Agent, MyTmux, Portals, Durable Streams and advanced extensions are later work.
