// Hand-run: records every scenario (`scenarios.ts`) on the installed Pi and writes `fixtures/<name>.json`, the AG-UI
// golden tests' input. Run it after a Pi upgrade or a scenario change, then `bun run fmt` and review the goldens:
//
//   bun apps/runtime/test/streams/record.ts && bun run fmt && (cd apps/runtime && bun x vitest run test/streams -u)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pi from '@earendil-works/pi-durable/package.json' with { type: 'json' }
import { type ScenarioName, record, scenarios } from './scenarios.ts'

const directory = fileURLToPath(new URL('fixtures', import.meta.url).href)
mkdirSync(directory, { recursive: true })
// SAFETY: `scenarios` is a literal object, so its keys are exactly its scenario names.
for (const name of Object.keys(scenarios) as ScenarioName[]) {
  const recording = await record(name)
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify({ pi: pi.version, ...recording }, null, 2)}\n`)
  console.log(`${name}: ${recording.batches.length} batches`)
}
