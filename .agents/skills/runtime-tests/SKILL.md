---
name: runtime-tests
description: Run or design goblin unit, workerd integration and dev-stage tests while keeping evidence classes apart. Use for test changes or failures.
---

# goblin runtime tests

Choose the test that proves the claim: unit tests, local workerd integration, reconstruction, and the deployed dev
smoke are different evidence.

- Vitest 5. Unit tests inject services (`test/mcp/memory.ts`) and run the official MCP SDKs in-process through an
  injected `fetch`. No `vi.mock`, no module mocking. Effect programs use `@effect/vitest` and layers made for the test
  (`FlowEvents.noop` where flows are not under test, `makeChanges()` for the change bus, real migrations in
  `node:sqlite` for stores).
- Owner API: serve one group in memory with only its area's services (`served([Group], handlers)` in
  `test/http/api/fixture.ts`), and call it through the typed client. The edge's admission (origin, session, CSRF on every write,
  plan, body cap, header allowlist) is unit-tested in `test/http/api/edge.test.ts`. Integration probes reach the agent
  through `test/owner-client.ts`, the typed client over the stub's `fetch` with `x-goblin-ref`; never an RPC
  method for an owner call. The owner stack's cases go through the real Worker as a signed-in browser
  (`signedIn(base, person)` in `test/integration/owner-requests.ts`) with the same client; a refusal is asserted by its
  tag (`answerOf`). Raw requests are for what the client cannot say: edge refusals, forged selectors and bodies, the
  auth routes and the SSE streams. The web serves the contract in memory with `fakeHttpApi`.
- Fakes are typed rather than cast to `never`: `fake<T>(members)` and `unread` (`test/fake.ts`), `executeTool` for a
  Pi tool (`test/pi-tool.ts`), `durable(db)` and `sqliteDb(db)` for node:sqlite (`test/chats-sqlite.ts`), and
  `stub(Tag, parts)` for a service.
- Content-freedom is tested where lines are made: the logger never writes a message or a cause, the reporter keeps only
  stack locations (`test/observability/`), and a crash report keeps no message.
- Integration tests boot workerd through Alchemy (`test/integration`) with a deterministic fixture model. Keep ports
  configurable; never destroy an Alchemy stack to clear a port conflict.
- A native probe is an entry of its module's `probes` record (`probe.ts`): `inAgent` runs inside the agent over its
  one `probe(name)` RPC method, `inWorker` in the test Worker against the agent's stub. The Worker serves them all on
  `GET /probe/<name>?name=<agent>`, and `native.test.ts` runs the case modules' `cases` (each with its `[canary]` tag
  where it has one) through `probeOf`. Poll with `until`/`waitFor` (`until.ts`).
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
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Billing native tests use a separate local D1/Worker and an injected Dodo API. Production account admission always
  reads auth D1; only the native model-test subclass injects entitlement policy. Prove checkout alone grants nothing,
  a signed activation opens the Agent, replay preserves the first receipt, cancellation/grace expire, and each account
  receives its own allowance. Real Dodo keys, checkout, merchant review and deployed webhook delivery are separate gates.

- Signed routine Events use the existing native stack and official fixture, including descriptor argument validation, shared-lease retirement, escaped IDs, replay after receipt retention across a new revision, sealed metadata labelling, global spacing and pending drain. Structural labelling does not prove model injection resistance; local throwaway-account CLIProxy acceptance and real producer/dev acceptance are separate evidence.

- Earliest-wake regressions must execute a real native callback and check that its successor remains scheduled. A direct manual call can miss self-suppression because `listSchedules` includes the firing row. LOCAL acceptance also waits for passive report acceptance; model settlement alone is incomplete evidence.

- Owner API/Apps tests use real auth D1 and PersonalAgent with a deterministic model and official injected MCP
  transport. Verify two-account isolation with forged selectors, removed access endpoints, per-call Apps and live
  grants. Applied dormant migrations remain intact.

- Home MCP regressions cover agent add rejection, owner add, closed/thread-closed retained tiles, unrelated edits and revoked App-caller grants. The no-auth inbox fixture builds the documented app, advances 15-minute job slots, keeps five validated messages and last-good data, and places its view. Browser receipts render the native-built view through a controlled feed; they do not prove a real signed-in inbox.
- Auth fixtures inject mail capture and use actual OTP endpoints against native D1. No capture endpoint ships in the deployed Worker. Verify closed/invite policy at send and sign-in, hashing, expiry, attempts, replay, rate limits, mail-failure cleanup and fresh-session deletion.

- Same-process native fixtures use a process-scoped Alchemy stage and fresh HTTP connections, so retained alarms and eviction sockets from previous runs do not leak into the next gate. Explicit write/read reconstruction retains its stable stage. Interrupted `code_run` reconstruction must keep the first file write and report interruption without replay. Routine cap fixtures observe Pi's bounded provider retry settlement before checking the terminal state; they do not retry the test or drop cap assertions.

- MCP ask-first native tests use authenticated owner requests, real D1/SQLite and official injected MCP transport.
  Keep assertions for frozen arguments and operationKey, redacted review, refusal, second-account isolation, changed
  grants/scopes, routine/subagent holds, alternate App refusal and reconstruction without dispatch replay. Real
  Sidequest hiring and provider-side operation reconciliation remain separate acceptance.

- Decisions (ADR 0031) are tested with an injected Clef and real SQLite: the native `decisions` probe uses the probe's
  own Clef and asserts one proposal per relay, the first label kept and replayed, a stale result discarded, no call once
  the budget is spent and nothing judged without Clef while chat goes on. The native stacks bind no `AI`; native gates
  never call paid Workers AI.
