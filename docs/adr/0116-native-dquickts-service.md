# ADR 0116: A local native dquickts service alongside WASM

Status: proposed (spike)

Amends [ADR 0115](0115-durable-code-run-with-dquickts.md) with a selectable native engine. WASM releases sandbox
slots at host boundaries but synchronous compute still blocks the owning agent's Worker isolate. The native path
moves that compute to a short-lived OS process while keeping Pi, the journal and all snapshots in the owning DO.
The default experimental engine stays WASM; the whole feature stays off unless opted in on local/test.

`DQUICKTS_ENGINE=native` uses a configurable `DQUICKTS_NATIVE_URL` with a test bearer and expected native build id.
Both endpoints enforce loopback HTTP; the controller binds only 127.0.0.1. There is no public/tailnet mode or deployment
configuration. The test setup generates the bearer, starts the controller and stops its own process. No real secret
or CI secret is used. The controller authenticates in constant time and MACs snapshots with a derived key, binding
run, build, base/delta and cumulative CPU counters. Build identity hashes binary plus controller. A changed build or
lost/rotated key cannot restore previous snapshots. The native exec image receives neither token nor controller
environment/descriptors. Server-side trusted snapshots and the existing SQLite integrity digest remain required.

Each eval/resume/snapshot/restore request forks then execs the pinned native embedding. The controller persists no
run state. The DO stores returned sealed base/delta bytes in its existing application checkpoint JSON/blob fields;
there is no vendor schema change. The same intent/result journal reuses completed calls, retries only known local
reads and exposes unfinished unsafe calls as indeterminate. No transaction or lifecycle gate spans HTTP or a host wait.

The native child has kernel-enforced 128 MiB address-space and CPU limits, a fractional CPU profiling timer and a
wall timer, with an owned-child kill backstop. `wait4` accounts user+system CPU including startup. QuickJS also has
an 8 MiB allocation cap. Before reading input the driver installs fail-closed Linux x86_64 seccomp denying socket
operations, spawning, exec and ptrace. Scripts have no network/filesystem bindings. This is not a full syscall
allowlist or a filesystem/user namespace sandbox against engine compromise. The controller and same-user host are
trusted; loopback HTTP provides no confidentiality from privileged local processes.

CPU defaults to 1,000 ms per run. Before HTTP the DO persists a reservation of min(remaining, 200 ms), asks the
service for 20 ms less, and refunds unused reservation only after a successful result using measured CPU. A lost
reply forfeits the reservation, so eviction cannot replenish CPU. The service MAC covers cumulative acknowledged
CPU and enforces the tighter of that counter and the DO allowance. It arms the profiling timer 10 ms early for
startup/tick granularity. This is conservative accounting, not a hard real-time scheduling guarantee. Controller
CPU and Worker CPU are outside that counter. Native slices suspend at host calls; compute exceeding a slice's
allowance terminates cleanly rather than gaining another quantum. Persisted wall/call/step/fuel/size limits still apply.

Local workerd tests cover real Pi recovery, DO SQLite eviction, completed/uncertain effects, slot release, MAC/build
rejection, kernel CPU across suspensions, address-space rejection, denied sockets, wall termination and unavailable
service. [SPIKE_RESULTS.md](../../SPIKE_RESULTS.md) separates per-operation timings, child CPU and an agent timer-lag
blocking proxy. DO billing and deployed Worker CPU remain unmeasured. Native allocation failure is observed; no
OOM-killer signal is claimed. The tiny controller serializes requests and has no production admission/backpressure.

Production would need a reviewed transport and service identity, strong OS isolation, key/build draining, workload
and concurrency limits, controller hardening, cancellation, retention and billing acceptance. No deployment or
production readiness is proposed by these local results.
