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
- Events tests use `test/mcp/events-fixture.ts` in workerd: exact capabilities, raw-byte signatures, challenge,
  replay, gaps, early refresh, termination, shared consumers, durable skill invalidation and failed-handler recovery.
  Reconstructed local services prove retained SQLite receipts; live producer and real eviction checks are separate.
- For skill-cache changes, keep a workerd regression that corrupts a persisted `app_skill_files` row, observes the
  refetch, and verifies the repaired bytes; unit tests alone do not prove Durable Object SQLite behavior.

Before changing an API call, read the current [documentation](https://vitest.dev/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Billing native tests use a separate local D1/Worker and an injected Dodo API. Production account admission always
  reads auth D1; only the native model-test subclass injects entitlement policy. Prove checkout alone grants nothing,
  a signed activation opens the Agent, replay preserves the first receipt, cancellation/grace expire, and each account
  receives its own allowance. Real Dodo keys, checkout, merchant review and deployed webhook delivery are separate gates.

- Members native tests use real auth D1 and PersonalAgent with captured injected mail. Prove ordinary accounts keep
  their own Agent, invitation accounts have no fallback, email/OTP admission and own-plan acceptance, proof rotation,
  stale contexts, concurrent/replayed receipts, leave payload rejection and deletion retry. Phase A members/viewers
  remain unable to call owner RPCs; shared execution and real invitation delivery require separate acceptance.

- Members query observations delegate to native D1 after session authentication. Established state, browser and owner
  resolution must each make one live workspace read with no writes; revocation/deletion cannot restore fallback.
  The scheduled Worker cleanup fixture runs without Dodo and proves 1000-row expiry bounds, retained live active/used
  admissions and hourly counters, and safe repeated sweeps. It sends no mail or provider requests.

- Signed routine Events use the existing native stack and official fixture, including descriptor argument validation, shared-lease retirement, escaped IDs, replay after receipt retention across a new revision, sealed metadata labelling, global spacing and pending drain. Structural labelling does not prove model injection resistance; local throwaway-account CLIProxy acceptance and real producer/dev acceptance are separate evidence.

- Earliest-wake regressions must execute a real native callback and check that its successor remains scheduled. A direct manual call can miss self-suppression because `listSchedules` includes the firing row. LOCAL acceptance also waits for passive report acceptance; model settlement alone is incomplete evidence.
