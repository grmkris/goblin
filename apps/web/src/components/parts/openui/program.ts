import { autoClose } from '@openuidev/lang-core'
import { createParser } from '@openuidev/react-lang'
import { library } from './library.tsx'
import { canonicalProgram } from './syntax.ts'

const parser = createParser(library.toJSONSchema(), library.root)
export const maxSourceLength = 20_000

/** A reply the Renderer may draw, as the program it draws, or why it stays code. */
export type CheckedProgram =
  | { readonly ok: true; readonly program: string }
  | { readonly ok: false; readonly problems: readonly string[] }

const refuse = (problem: string): CheckedProgram => ({ ok: false, problems: [problem] })

/**
 * Validate before mounting the interpreter: no hosted bundles, tools, or incomplete programs. The Renderer receives only
 * `program`, the printed form of what was checked, never the reply's own text.
 */
export function checkProgram(source: string): CheckedProgram {
  if (source.trim() === '') return refuse('Enter an OpenUI program to render.')
  if (source.length > maxSourceLength) return refuse('Keep the program under 20,000 characters.')
  if (source.includes(']]>')) return refuse('Hosted message bundles are not supported.')
  if (autoClose(source).wasIncomplete) return refuse('The program is incomplete.')
  try {
    const program = canonicalProgram(source)
    if (program === undefined)
      return refuse('Use a bounded Stack of supported components, literals and named references.')
    // The Renderer reads `]]>` as a message marker even inside a string, so a decoded escape must not form one either.
    if (program.includes(']]>')) return refuse('Hosted message bundles are not supported.')
    const result = parser.parse(program)
    if (result.queryStatements.length > 0 || result.mutationStatements.length > 0)
      return refuse('Queries and mutations are not supported in replies.')
    if (result.meta.incomplete || result.root === null || result.meta.unresolved.length > 0)
      return refuse('The program is incomplete.')
    const problems = [...new Set(result.meta.errors.map((error) => error.message))]
    return problems.length > 0 ? { ok: false, problems } : { ok: true, program }
  } catch {
    // expected: model-authored source may be malformed; the reply keeps its code fallback.
    return refuse('This program could not be parsed.')
  }
}

/** Why a reply stays code; empty when it can be drawn. */
export const programProblems = (source: string): readonly string[] => {
  const checked = checkProgram(source)
  return checked.ok ? [] : checked.problems
}
