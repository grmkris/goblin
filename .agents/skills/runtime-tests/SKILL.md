---
name: runtime-tests
description: Run or design Purrable unit, workerd integration and dev-stage tests while keeping evidence classes apart. Use for test changes or failures.
---

# Purrable runtime tests

Choose the test that proves the claim: unit tests, local workerd integration, reconstruction, and the deployed dev
smoke are different evidence.

- Vitest 5. Unit tests inject services (`test/mcp/memory.ts`) and run the official MCP SDKs in-process through an
  injected `fetch`. No `vi.mock`, no module mocking.
- Integration tests boot workerd through Alchemy (`test/integration`) with a deterministic fixture model. Keep ports
  configurable; never destroy an Alchemy stack to clear a port conflict.
- Test grants and resident authority before any model, MCP or App call.
- No credentials in fixtures, transcripts, logs or receipts.
- `bun run smoke:local` and `bun run smoke:dev` prove the real paths, including inbound OAuth, without touching the
  owner's main thread or grants.
- Report provider, network, auth and deployment gaps as unknown; synthetic tests do not prove real hosts.

Before changing an API call, read the current [documentation](https://vitest.dev/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.
