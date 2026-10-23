# ADR 0115: Durable code_run with dquickts

Status: proposed (spike)

Proposes an opt-in amendment to [ADR 0021](0021-agent-apps.md)'s disposable `code_run` backend.
The default async Dynamic Worker path and its unsafe replay policy stay in use. No app action executor changes.

## Problem and evidence

A script occupies an isolate slot while awaiting its host. Restarting a script can repeat effects. The current
backend correctly refuses unsafe replay; the earlier `spike/durable-codemode` attempt at `1aa94bac` instead used Pi's
remote sandbox and deterministic replay. The supplied dquickts Spike 0 proved WASM suspension and heap restoration.
This spike tests the remaining application boundary in the local native workerd harness, with fake hosts and models.

## Proposed slice

`DQUICKTS_CODE_RUN=spike`, on local/test bindings only, gives Pi's `code_run` a synchronous TypeScript body and
`files.read/list/write`, `tools.call(connectionId,name,arguments)` and `log`. Async frames, timers and parallel
Promise workflows are outside this slice: dquickts cannot suspend a host call through those frames. The flag is
ignored on dev and prod. No deployment configuration enables it.

Each Pi `(conversation, callId)` is one durable run. Pi still owns tasks, transcripts and wake-up; its safe recovery
reenters the runner with the same id. New additive `app_code_runs` and `app_code_calls` tables belong to application
storage through Drizzle. Every host call and bounded compute quantum checkpoints a delta against the initial base,
disposes the WASM instance, then releases the shared eight-slot budget before any host wait. Restoration always
uses a fresh instance. No SQLite transaction or lifecycle gate spans a wait.

Checkpoint integrity binds the bytes, build, source, run id and counters with SHA-256. This detects corruption, not
an attacker with database write access; snapshots remain trusted, server-only data. The build identity names the
exact WASM artifact and host registry. Neither a browser nor an MCP caller supplies snapshot bytes.

The journal records an intent before dispatch and a response before advancing the heap. Recovery reuses recorded
responses. An unfinished local read/list may retry; an unfinished write or MCP call is **indeterminate** and stops
the script. This borrows OC++'s conservative rule. Remote `readOnlyHint` annotations never authorize a retry. Calls
still pass the existing app-service resident authority, session scope, exact grants and Ask first refusal checks.
No exactly-once external effect is claimed. The stable journal id is not a provider idempotency guarantee.

Limits persist across checkpoints: elapsed deadline (including restart downtime), host calls, VM steps and interrupt
fuel, plus snapshot/output size and engine memory caps. Before each slice, the store reserves the maximum compute
quantum; a successful checkpoint records the VM's remaining fuel. A crash before that checkpoint forfeits the
reservation, so reconstruction cannot replenish fuel. Interrupt fuel bounds synchronous execution. Snapshot
storage uses base64 and rewrites the current delta; the journal grows with calls. There is no cross-run notebook.

## Consequences and limits

The local tests prove state restoration, actual Pi recovery after explicit object eviction, uncertain effects,
integrity/build guards, cumulative budgets and slot release. Timing evidence and comparisons are in
[SPIKE_RESULTS.md](../../SPIKE_RESULTS.md). Slot savings are measured locally. Billed DO time and deployed CPU are
unmeasured: the agent request still waits on its host, so this slice does not establish hibernation or billing savings.

Before adoption: security review of the fork and host ABI, async language/API decision, packaging acceptance,
retention/quota policy, cancellation/deadline propagation into hosts, production memory/concurrency measurements,
authoritative read-only classification, and build upgrade/drain rules. A crash can consume an unused reserved
quantum, so fuel is intentionally conservative. The default remains off pending those decisions.
