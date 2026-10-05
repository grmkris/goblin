# Benchmark workspace

Read the root instructions first. This workspace owns bounded, reproducible memory experiments; it is not deployed
runtime code. Keep synthetic fixtures deterministic and free of secrets. Private corpora and run artifacts stay under
`.local/bench/` or another explicitly ignored path. Live model calls require an explicit manifest, dry-run output,
request/token ceilings, and a separate local provider configuration.

Use native Pi adapters for runtime evidence and pure functions for schemas, fixture generation, planning and scoring.
Never touch Pi vendor tables directly. Preserve append-only run ledgers, immutable manifests and failure traces. Keep
model IDs, prompts, pressure settings and cache keys in the manifest so a result can be reproduced or rejected as
incompatible. Use injected providers in tests; do not mock modules.
