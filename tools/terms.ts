/** Keep retired integrations out of shipped code without reserving ordinary product vocabulary. */
const SOURCE_ROOTS = [
  'apps/runtime/src/',
  'apps/web/src/',
  'apps/cli/src/',
  'packages/contracts/src/',
  'packages/ui/src/',
  'packages/app/src/',
  'packages/kit/src/',
]

// The shelf describes external servers to the owner. Its names and endpoints are data, never dispatch branches.
const SHELF = 'apps/runtime/src/mcp/servers/shelf.ts'
const RETIRED = new Set(['telegram', 'mygram', 'mercator', 'wallet', 'usdc', 'tempo', 'dodo', 'x402', 'mpp', 'credits'])
const BILLING = new Set(['planid', 'plantier', 'planoverride', 'planlimits', 'firstclassserver', 'firstclassservers'])
const HOST = /\b(?:goblin\.surf|mysi\.lol)\b/giu
const IDENTIFIER = /[A-Za-z_][A-Za-z_0-9]*/gu

export type TermViolation = { readonly line: number; readonly term: string }

/** Source files only; colocated tests, historical evidence, operator scripts and shelf data have separate purposes. */
export const guardedSource = (file: string): boolean =>
  SOURCE_ROOTS.some((root) => file.startsWith(root)) &&
  /\.(?:[cm]?[jt]sx?|css)$/u.test(file) &&
  !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
  !file.includes('/__tests__/') &&
  file !== SHELF

const retiredIdentifier = (identifier: string): string | undefined => {
  const joined = identifier.replaceAll('_', '').toLowerCase()
  if (BILLING.has(joined)) return identifier
  // MyGram is the same service as mygram; camel-case splitting would otherwise hide its name.
  if (joined.includes('mygram')) return 'mygram'
  const words = identifier
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split('_')
  return words.find((word) => RETIRED.has(word))
}

/** Comments and strings count too: current source must describe current behavior. No source text enters the report. */
export const termViolations = (file: string, source: string): readonly TermViolation[] => {
  if (!guardedSource(file)) return []
  return source.split('\n').flatMap((line, index) => {
    const terms = new Set<string>([...line.matchAll(HOST)].map(([host]) => host.toLowerCase()))
    for (const [identifier] of line.matchAll(IDENTIFIER)) {
      const term = retiredIdentifier(identifier)
      if (term !== undefined) terms.add(term)
    }
    return [...terms].map((term) => ({ line: index + 1, term }))
  })
}
