/**
 * goblin starts with zero accepted lint/Effect/Knip findings. `--skip effect` leaves the Effect diagnostics out, for
 * `bun run check`, whose typecheck has just run the same pass on every project (tools/pass.ts, ADR 0120).
 */
import { collect, SOURCES } from './findings.ts'
const args = Bun.argv.slice(2)
const skipped = args[0] === '--skip' && args.length === 2 ? SOURCES.find((source) => source === args[1]) : undefined
if (args.length > 0 && skipped === undefined) {
  console.error(`usage: bun run lint:gate [--skip ${SOURCES.join('|')}]`)
  process.exit(2)
}
const result = await collect(SOURCES.filter((source) => source !== skipped))
for (const failure of result.failures) console.error(failure)
for (const finding of result.findings)
  console.error(`${finding.file}:${finding.line}:${finding.source} ${finding.rule}`)
console.info(`lint:gate: ${result.findings.length} findings, ${result.failures.length} collection failures`)
process.exitCode = result.findings.length === 0 && result.failures.length === 0 ? 0 : 1
