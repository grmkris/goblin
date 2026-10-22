/** A scoped guard against restoring removed integrations or billing concepts in shipped code and its tests. */
import { readFileSync } from 'node:fs'
import { repoRoot } from './run.ts'
import { guardedSource, guardedTest, termViolations } from './terms.ts'

const failures: string[] = []
for (const file of new Bun.Glob('{apps,packages}/*/{src,test}/**/*.{ts,tsx,js,jsx,mts,cts,css}').scanSync({
  cwd: repoRoot,
})) {
  if (!guardedSource(file) && !guardedTest(file)) continue
  for (const { line, term } of termViolations(file, readFileSync(`${repoRoot}/${file}`, 'utf8')))
    failures.push(`${file}:${String(line)}: retired integration or billing term: ${term}`)
}
if (failures.length > 0) {
  for (const failure of failures.toSorted()) console.error(failure)
  process.exitCode = 1
} else console.log('retired-terms guard passed')
