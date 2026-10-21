import type { JsonSchemaType, Tool } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import * as Effect from 'effect/Effect'
import { InvalidArguments } from '../../http/errors.ts'
import { oneLine } from './errors.ts'

// A tool call's arguments checked against the tool's input schema before they are sent (ADR 0092): a call that does not
// fit is refused with every problem listed, so the model can fix it, rather than with whatever the server answers.

/** At most this many problems are kept of one call, each at most this many characters. */
const MAX_PROBLEMS = 12
const MAX_PROBLEM = 200

/** The MCP SDK's Workers-safe validator, reporting every problem rather than the first. */
const validator = new CfWorkerJsonSchemaValidator({ shortcircuit: false })

/** One schema's check: the validator's message for arguments that do not fit, none for ones that do. */
type Check = (args: unknown) => string | undefined

/**
 * Each tool's compiled check, by its input schema as listed (the manager keeps one): a new listing is a new schema
 * object, compiled anew, and one no longer listed is let go. `open` marks a schema the validator cannot compile.
 */
export type ArgumentChecks = WeakMap<object, Check | 'open'>

/**
 * `schema` without its `format` keywords, which JSON Schema 2020-12 makes annotations: a server may not check them, so
 * goblin does not refuse what it would take. A property named `format` is a schema object, and stays.
 */
const withoutFormats = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(withoutFormats)
  if (schema === null || typeof schema !== 'object') return schema
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => !(key === 'format' && typeof value === 'string'))
      .map(([key, value]) => [key, withoutFormats(value)]),
  )
}

/** `schema` compiled, or `open` when the validator cannot compile it (another dialect, a duplicate `$id`). */
const compile = (schema: Tool['inputSchema']): Check | 'open' => {
  try {
    // The validator marks the schema it compiles: it gets a copy without `format`s, so the tool as listed stays as it was.
    // SAFETY: a tool's input schema is a JSON Schema object in the tools/list response the SDK validated; its optional
    // keywords are absent, never undefined, and dropping `format` keeps it one.
    const validate = validator.getValidator(withoutFormats(schema) as JsonSchemaType)
    return (args) => {
      const result = validate(args)
      return result.valid ? undefined : result.errorMessage
    }
  } catch {
    // expected: a schema goblin cannot read does not hold the call back; the server checks it, as before.
    return 'open'
  }
}

/** The validator's message for `args`, none when they fit or cannot be checked. */
const verdict = (checks: ArgumentChecks, schema: Tool['inputSchema'], args: unknown): string | undefined => {
  const known = checks.get(schema)
  const check = known ?? compile(schema)
  if (known === undefined) checks.set(schema, check)
  if (check === 'open') return undefined
  try {
    return check(args)
  } catch {
    // expected: the validator throws on a `$ref` it cannot resolve, which it meets only for some arguments; the server
    // checks those, as before.
    return undefined
  }
}

/** What the validator found at one place in the arguments: `#` is the whole, `#/step/source` one field. */
type Finding = { readonly at: string; readonly text: string }

/** A place as the validator writes it: `#`, then a URI-encoded JSON pointer. */
const PLACE = /^#\S*$/u

/**
 * The validator's findings, which it joins as `<place>: <problem>` with `; `. A `; #` inside a quoted name splits a
 * finding, which is put back together.
 */
const findingsOf = (message: string): Finding[] => {
  const findings: Finding[] = []
  for (const part of message.split(/; (?=#)/u)) {
    const colon = part.indexOf(': ')
    const at = colon < 0 ? '' : part.slice(0, colon)
    const last = findings.at(-1)
    if (PLACE.test(at)) findings.push({ at, text: part.slice(colon + 2) })
    else if (last !== undefined) findings.splice(-1, 1, { at: last.at, text: `${last.text}; ${part}` })
  }
  return findings
}

/** Findings that only say the problems listed after them are there. */
const SUMMARIES: ReadonlySet<string> = new Set([
  'A subschema had errors.',
  'Items did not match schema.',
  'Items did not match additional items schema.',
  'Items did not match unevaluated items schema.',
  'Instance does not match "then" schema.',
  'Instance does not match "else" schema.',
])

/** The property a finding `Property "<key>"<rest>` names. */
const property = (text: string, rest: string): string | undefined => {
  const head = 'Property "'
  const tail = `"${rest}`
  return text.length >= head.length + tail.length && text.startsWith(head) && text.endsWith(tail)
    ? text.slice(head.length, -tail.length)
    : undefined
}

/** A property the schema declares, whose own problems are listed after it. */
const declared = (text: string) => property(text, ' does not match schema.')

/** A property under `additionalProperties` or `unevaluatedProperties`, whose problems are listed after it. */
const undeclared = (text: string) =>
  property(text, ' does not match additional properties schema.') ??
  property(text, ' does not match unevaluated properties schema.')

/** A summary of a property that matches a `patternProperties` pattern, whose problems are listed after it. */
const patterned = (text: string) => property(text, ' but does not match associated schema.') !== undefined

/** Whether the only finding after the one at `index` is the `false` schema of the property it names. */
const refused = (findings: readonly Finding[], index: number, at: string): boolean =>
  findings[index + 1]?.text === 'False boolean schema.' &&
  findings[index + 1]?.at.startsWith(`${at}/`) === true &&
  findings[index + 2]?.at.startsWith(`${at}/`) !== true

/**
 * The findings that say what is wrong, in order: summaries are left out, since what they sum up follows them; a
 * property `additionalProperties: false` refuses reads as not allowed. The validator also checks a declared property
 * that failed its own schema against `additionalProperties`, so that echo is left out with what follows it.
 */
const telling = (findings: readonly Finding[]): Finding[] => {
  const failed = new Set<string>()
  const kept: Finding[] = []
  let echo: string | undefined
  for (const [index, { at, text }] of findings.entries()) {
    if (echo !== undefined && at.startsWith(echo)) continue
    echo = undefined
    const field = declared(text)
    const extra = undeclared(text)
    if (field !== undefined) failed.add(`${at}\n${field}`)
    else if (extra !== undefined && failed.has(`${at}\n${extra}`)) echo = `${at}/`
    else if (extra !== undefined && refused(findings, index, at)) {
      kept.push({ at, text: `Property "${extra}" is not allowed.` })
      echo = `${at}/`
    } else if (extra === undefined && !SUMMARIES.has(text) && !patterned(text)) kept.push({ at, text })
  }
  return kept
}

/** A place as a JSON pointer, `/` for the whole arguments. */
const pointer = (at: string): string => {
  const path = at.slice(1)
  try {
    return decodeURI(path) || '/'
  } catch {
    // expected: a pointer that does not decode is shown as the validator wrote it.
    return path || '/'
  }
}

/** The problems of a validator's message, each `<pointer>: <problem>` on one bounded line, at most {@link MAX_PROBLEMS}. */
const problemsOf = (message: string): string[] => {
  const findings = findingsOf(message)
  const kept = telling(findings)
  const shown = (kept.length > 0 ? kept : findings).slice(0, MAX_PROBLEMS)
  const problems = shown.map(({ at, text }) => oneLine(`${pointer(at)}: ${text}`, MAX_PROBLEM))
  return problems.length > 0 ? problems : ['/: The arguments do not match the schema.']
}

/**
 * `args`, as they would be sent, checked against `tool`'s input schema: `InvalidArguments` with what is wrong when they
 * do not fit. A schema the validator cannot compile, or a check it cannot finish, lets the call go as before.
 */
export const checkArguments = (checks: ArgumentChecks, connectionId: string, tool: Tool, args: unknown) =>
  Effect.suspend(() => {
    const message = verdict(checks, tool.inputSchema, args)
    return message === undefined
      ? Effect.void
      : Effect.fail(new InvalidArguments({ connectionId, name: tool.name, problems: problemsOf(message) }))
  })
