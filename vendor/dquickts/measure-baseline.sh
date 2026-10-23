#!/usr/bin/env bash
# Run through heavy. Only test instrumentation is added to an isolated, unmodified base runtime.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
baseline_dir="$root/.local/durable-code/control-$$"
git -C "$root" worktree add --detach "$baseline_dir" "${1:-origin/dev}"
trap 'git -C "$root" worktree remove --force "$baseline_dir"' EXIT
ln -s "$root/node_modules" "$baseline_dir/node_modules"
ln -s "$root/apps/runtime/node_modules" "$baseline_dir/apps/runtime/node_modules"
cp "$root/apps/runtime/test/integration/durable-code-baseline.ts" "$baseline_dir/apps/runtime/test/integration/"
python3 - "$baseline_dir" <<'PY'
from pathlib import Path
import sys
tests = Path(sys.argv[1]) / 'apps/runtime/test/integration'
worker = tests / 'worker.ts'
source = "import { probes as durableCodeBaseline } from './durable-code-baseline.ts'\n" + worker.read_text()
worker.write_text(source.replace('const PROBES = registry(', 'const PROBES = registry(\n  durableCodeBaseline,', 1))
(tests / 'durable-code-control.test.ts').write_text('''import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { probeOf } from './native-case.ts'
import Stack from './stack.ts'
const harness = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), stage: `test_durable_control_${process.pid}`, dev: true })
const stack = harness.beforeAll(harness.deploy(Stack))
harness.test('unmodified origin/dev: three slow ScriptFiles calls', Effect.gen(function* () {
  const {url} = yield* stack
  const result = yield* Effect.promise(() => probeOf(url, 'durable-code-baseline', Schema.Unknown))
  expect(result).toMatchObject({samples: Array.from({length: 5}, () => ({result: {ok: true, value: 3}}))})
  writeFileSync('../../../baseline-control.json', JSON.stringify(result, null, 2))
}))
''')
PY
GOBLIN_HARNESS_PORT="${GOBLIN_BASELINE_PORT:-24861}" bun --cwd "$baseline_dir/apps/runtime" test:integration test/integration/durable-code-control.test.ts
