---
name: cloudflare-agents
description: Change the native Cloudflare Agent shell, Durable Object identity, lifecycle adapters, and authorized runtime transport in Purrable.
---

# Cloudflare Agents in Purrable

Keep `PersonalAgent extends Agent` thin. Alchemy directly declares/binds the native class; business logic belongs in modules and Effect services.

- One object per agent identity; SQLite storage is the durable platform boundary.
- Register PiHarness through the current lifecycle API and preserve storage/context ownership.
- Do not import Alchemy deployment code into workerd; it may load Node process modules.
- Keep inbound user authentication separate from outbound MCP authorization. Validate principal/tenant and capability grants at the boundary.
- Keep resource/lifecycle acquisitions scoped and disposal explicit; transactions/gates never span network/model work.
- Verify runtime-class exports and generated Cloudflare bindings against the built artifact and the chosen harness.

Read the current [official documentation](https://developers.cloudflare.com/agents/), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
