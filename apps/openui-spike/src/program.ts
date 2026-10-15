import { createParser } from '@openuidev/react-lang'
import { library } from './library.tsx'

const parser = createParser(library.toJSONSchema(), library.root)
export const maxSourceLength = 20_000

/** The playground accepts plain, bounded programs; no tools or hosted script bundles. */
export function programProblems(source: string): string[] {
  if (source.trim() === '') return ['Enter an OpenUI program to render.']
  if (source.length > maxSourceLength) return ['Keep the program under 20,000 characters.']
  if (source.includes(']]>openui:')) return ['Paste plain OpenUI source. Hosted message bundles are not supported.']
  try {
    const result = parser.parse(source)
    if (result.queryStatements.length > 0 || result.mutationStatements.length > 0)
      return ['Queries and mutations are disabled in this fixture playground.']
    const problems = result.meta.errors.map((error) => error.message)
    if (result.meta.unresolved.length > 0) problems.push(`Undefined names: ${result.meta.unresolved.join(', ')}`)
    return [...new Set(problems)]
  } catch {
    // expected: the public source editor accepts malformed input; show a fixed parse diagnostic.
    return ['This program could not be parsed. Check its brackets, strings, and component names.']
  }
}
