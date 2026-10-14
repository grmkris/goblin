# Tests

Use Vitest 5. Unit tests run in Node with injected services; MCP tests use the official MCP server in-process through
an injected `fetch`. Runtime integration tests boot local workerd through Alchemy (`apps/runtime/test/integration`)
with a deterministic fixture model and no network.

Use injected services/layers instead of module mocking. Keep harness ports configurable and state isolated per run.
Never destroy an Alchemy harness stack to resolve a port conflict; stop only processes you own.

The owner API is tested by serving one group in memory with only its area's services, through the shared fixture
(`apps/runtime/test/http/api/fixture.ts`: `served`, `serve`, `stub`, the request builders); the Worker's
admission has its own unit tests (`edge.test.ts`). Those tests and the integration cases call the owner API through one
typed client (`test/owner-client.ts`): over the agent's `fetch`, or through the real Worker signed in (`signedIn`),
never through a Durable Object RPC method; the internal API has its own (`test/internal-client.ts`). The native suite is
a table of probes each module registers (`probes`, served on one test route; see the [runtime-tests
skill](../../.agents/skills/runtime-tests/SKILL.md)). The web serves the contract in memory with `fakeHttpApi` (ADR
0038), with `unusedHandlers(group)` for the endpoints a test never calls.

The native suite covers initialization, durable submission/deduplication, transcript readback and public
dispose/reopen. `GOBLIN_NATIVE_LIFECYCLE_PHASE=write|read` runs the two-process reconstruction proof; the ordinary
gate does not claim it. Reconstruction in local workerd is not proof of remote eviction.

Use stable operation IDs and readback for retried submissions. A fixture model cannot prove real streaming or
tool-calling against a provider; the deployed dev smoke (`bun run smoke:dev`) covers that.
