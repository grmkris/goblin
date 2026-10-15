import { createParser } from '@openuidev/react-lang'
import { library } from './library.tsx'
import { validSyntax } from './syntax.ts'

const parser = createParser(library.toJSONSchema(), library.root)
export const maxSourceLength = 20_000

/** Validate before mounting the interpreter: no hosted bundles, tools, or incomplete programs. */
export function programProblems(source: string): string[] {
  if (source.trim() === '') return ['Enter an OpenUI program to render.']
  if (source.length > maxSourceLength) return ['Keep the program under 20,000 characters.']
  if (source.includes(']]>openui:')) return ['Hosted message bundles are not supported.']
  try {
    if (!validSyntax(source)) return ['Use a bounded Stack of supported components, literals and named references.']
    const result = parser.parse(source)
    if (result.queryStatements.length > 0 || result.mutationStatements.length > 0)
      return ['Queries and mutations are not supported in replies.']
    if (result.meta.incomplete || result.root === null || result.meta.unresolved.length > 0)
      return ['The program is incomplete.']
    return [...new Set(result.meta.errors.map((error) => error.message))]
  } catch {
    // expected: model-authored source may be malformed; the reply keeps its code fallback.
    return ['This program could not be parsed.']
  }
}
