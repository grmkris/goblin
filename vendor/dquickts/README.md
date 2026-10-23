# dquickts WASM embedding (spike)

Pinned upstream: [stencil-hq/dquickts](https://github.com/stencil-hq/dquickts/tree/f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406),
commit `f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406`. MIT license in `LICENSE`.
The prerequisite Spike 0 verdict was **WORKS**, including fresh-instance suspend/snapshot/restore/resume in local workerd.
This uses WASM inside the owning agent object; no native service or HTTP hop is involved.

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
