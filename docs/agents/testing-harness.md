# Tests and evidence

Use Vitest 5. The compatibility record selects the supported Workers test harness after checking exact dependency APIs. Unit tests, local workerd behavior, PiHarness instance reconstruction, and real isolated Cloudflare dev acceptance are separate evidence classes; never promote one to another.

Use injected services/layers instead of module mocking. Keep harness ports configurable, state isolated by test run, and evidence in an owned fresh temporary directory. Resolve Playwright's browser through its registry when browser tests require it. Never destroy an Alchemy harness stack to resolve a port conflict; stop only processes you own.

Prove real PiHarness initialization, supported persistence, reconstruction against the same SQLite state, and public-API read/resume separately. A second read of one live object is not restart/eviction proof. App migrations must leave the verified full vendor ownership set untouched.

The retained native integration suite includes initialization, durable submission/deduplication, transcript readback
and public dispose/reopen. [The stack report](../stack-compatibility.md) gives the two explicit process commands for
storage reconstruction; the ordinary gate does not silently claim that separate proof.

Use stable operation IDs and receipt/readback for retried submissions. Authentication, grants, cancellation, reconnect snapshot replacement, metadata/rich-result preservation, and sandboxed Apps messaging deserve focused integration tests. A mocked provider cannot prove real streaming/tool-calling support or deployed reachability.

Run scoped checks first and heavy suites only after the coordinator assigns capacity. When failures touch foreign dirty files, preserve them and attribute the failure. Keep snapshot regeneration deliberate and named in the change. Provider/auth/network blockers remain explicit gaps in compatibility evidence.
