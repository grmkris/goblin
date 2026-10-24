# dquickts WASM and native embeddings (spike)

Pinned upstream: [stencil-hq/dquickts](https://github.com/stencil-hq/dquickts/tree/f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406),
commit `f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406`. MIT license in `LICENSE`.
The prerequisite Spike 0 verdict was **WORKS**, including fresh-instance suspend/snapshot/restore/resume in local workerd.
The default experimental engine uses WASM inside the owning agent object. An optional native engine moves compute
to a local HTTP controller and a fresh, limited child process; both keep snapshots in the owning object's SQLite.

The reactor is committed at `apps/runtime/src/agent-apps/dquickts/engine.wasm`. Its SHA-256 is recorded in
`SHA256SUMS` and in the runtime's build identity; a unit test checks agreement. Snapshots are trusted server-only
input, tied to this exact artifact and host registry. Do not accept uploaded snapshots.

Rebuild inside this checkout, with wasi-sdk 34 (clang 23.1.0-wasi-sdk):

```sh
mkdir -p .local/durable-code
git clone https://github.com/stencil-hq/dquickts.git .local/durable-code/source
git -C .local/durable-code/source checkout f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406
git -C .local/durable-code/source apply ../../../vendor/dquickts/0001-remove-unused-setjmp.patch
# Optional: only needed to rebuild the upstream snapshot test suite:
git -C .local/durable-code/source apply ../../../vendor/dquickts/0002-portable-suspension-test-allocator.patch
heavy bash vendor/dquickts/build.sh .local/durable-code/source /path/to/wasi-sdk-34.0-x86_64-linux
sha256sum -c vendor/dquickts/SHA256SUMS
```

`build.sh` is derived from Spike 0's build driver. The first patch removes an unused `setjmp.h` include that WASI
cannot compile; the second adapts the upstream test allocator to WASI and wasm32 word sizes.
The embedding links no filesystem, module loader, networking, quickjs-libc, Intl or Temporal.

Compared with Spike 0's driver, `driver.c` adds cumulative interrupt fuel and a 20-interrupt compute quantum, limits
QuickJS allocations to 8 MiB, caps WASM linear memory at 32 MiB, and rejects overlong JSON instead of truncating it.
Its static output buffer is bounded. `_initialize` runs before the ABI.
The TypeScript host copies snapshots before disposal and restores into a fresh instance at every boundary.
The build normalizes source paths embedded by C assertions, so checkout locations do not leak into the artifact
or alter its hash. The recorded artifact was rebuilt and checked against its pinned SHA after this normalization.

WASI imports are only time, randomness and refused descriptor operations. These imports belong to the C engine,
not the script. Scripts see JSON host-call shims and cannot access Worker bindings or network objects. Local workerd
tests compile the module before invocation through Alchemy's existing CompiledWasm rule. Production packaging and
CPU/billing acceptance remain deferred; see [SPIKE_RESULTS.md](../../SPIKE_RESULTS.md).

For the synthetic three-read baseline, the following command creates a detached checkout under `.local/durable-code`,
adds only test instrumentation, reuses installed dependencies, runs local workerd and removes its checkout on exit:

```sh
heavy bash vendor/dquickts/measure-baseline.sh e06aae34
heavy env GOBLIN_HARNESS_PORT=22861 bun --cwd apps/runtime test:integration test/integration/durable-code.test.ts test/integration/code-recovery.test.ts
```

The first command writes `.local/durable-code/baseline-control.json`; the second writes the flagged timings,
checkpoint/replay comparison and eviction samples beside it. Set `GOBLIN_BASELINE_PORT` if the baseline port is busy.
Both commands use fake/local hosts only. These are elapsed local measurements, not billed DO duration or Worker CPU.

## Native local service

After preparing the same pinned source above, build with Linux x86_64 GCC and Python 3 installed:

```sh
heavy bash vendor/dquickts/build-native.sh .local/durable-code/source
GOBLIN_DQUICKTS_ENGINE=native GOBLIN_HARNESS_PORT=22861 heavy bun --cwd apps/runtime test:integration test/integration/durable-code.test.ts test/integration/code-recovery.test.ts
```

To regenerate the complete comparison receipt, also run the WASM suite, unit timing fixture and original base control:

```sh
GOBLIN_HARNESS_PORT=22861 heavy bun --cwd apps/runtime test:integration test/integration/durable-code.test.ts test/integration/code-recovery.test.ts
heavy bun --cwd apps/runtime test:unit
heavy bash vendor/dquickts/measure-baseline.sh e06aae34
python3 vendor/dquickts/summarize-native.py
```

The test setup starts `native-service.py` on an ephemeral **127.0.0.1** port, generates a random local bearer on stdin,
injects its URL/token/build bindings, and terminates only its owned controller afterward. There is no public or
tailnet bind option. No real secrets or CI secret changes are needed. Native tests require the binary in
`.local/native/dquickts-native`; it is intentionally not committed. The build command prints its hash; the measured
build hash and sanitized receipts are in [the native evidence](../../evidence/durable-code-native-2026-10-24/).

`DQUICKTS_ENGINE=native` selects the service only inside the existing `DQUICKTS_CODE_RUN=spike` local/test gate.
Unset/`wasm` keeps WASM. Bind `DQUICKTS_NATIVE_URL`, `DQUICKTS_NATIVE_TOKEN`, `DQUICKTS_NATIVE_BUILD` from the test
controller. Both service and Worker restrict the hop to loopback HTTP. `/eval`, `/resume`, `/snapshot`, `/restore`
return their snapshot to the caller; the service keeps no run state. Service MAC checks, Worker build/integrity
checks and the journal remain server-side. Never supply client snapshots.

Every request forks/execs a native driver with empty environment and closed extra descriptors. Before exec the
controller sets 128 MiB `RLIMIT_AS`, `RLIMIT_CPU`, fractional `ITIMER_PROF`, and a wall timer. `wait4` reports actual
user+system child CPU. Native code installs x86_64 seccomp before processing input; socket syscalls fail with EPERM,
and process spawning/exec/ptrace are denied. Scripts have no file/network bindings. This is a denylist, not a complete
OS sandbox against a native engine exploit. QuickJS retains its separate 8 MiB allocation cap.

The DO reserves up to 200 ms before dispatch, passes 20 ms less to the service, and refunds only measured CPU on a
successful response. A lost response forfeits the slice. The service subtracts a further 10 ms timer/startup margin;
profiling timers have kernel-tick granularity. A CPU-heavy slice that cannot reach a host boundary within its
allowance fails rather than preempting into a snapshot. See [ADR 0116](../../docs/adr/0116-native-dquickts-service.md)
for cumulative accounting, trust and rollout limits. Controller CPU is not charged to the script counter.
