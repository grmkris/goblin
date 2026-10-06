# Tests

Use Vitest 5. Unit tests run in Node with injected services; MCP tests use the official MCP server in-process through
an injected `fetch`. Runtime integration tests boot local workerd through Alchemy (`apps/runtime/test/integration`)
with a deterministic fixture model and no network.

Use injected services/layers instead of module mocking. Keep harness ports configurable and state isolated per run.
Never destroy an Alchemy harness stack to resolve a port conflict; stop only processes you own.

The native suite covers initialization, durable submission/deduplication, transcript readback and public
dispose/reopen. `GOBLIN_NATIVE_LIFECYCLE_PHASE=write|read` runs the two-process reconstruction proof; the ordinary
gate does not claim it. Reconstruction in local workerd is not proof of remote eviction.

Use stable operation IDs and readback for retried submissions. A fixture model cannot prove real streaming or
tool-calling against a provider; the deployed dev smoke (`bun run smoke:dev`) covers that.
