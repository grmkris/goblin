import type { JsonObject, JsonValue } from '@goblin/contracts'
import { Compile } from 'typebox/compile'
import { isRecord } from '../runtime/digest.ts'
import type { JsonSchema } from './typed-tool.ts'

// A Persona fork's native MCP tools (ADR 0101): one naming rule for every app's tools, `<server>__<tool>`, and the remote
// words and schemas the model reads as its own, bounded and cleaned (ADR 0102). Pure: the set's builder
// (`pi/fork-tools.ts`) reads the connections, scope and grants.

/** A native tool's whole name, as every provider takes it. */
export const NATIVE_NAME = /^[A-Za-z0-9_-]{1,64}$/u

/** The separator between a server's alias and its tool's name. goblin's own tools never hold it. */
export const SEPARATOR = '__'

/** The longest server alias. */
const MAX_ALIAS = 20

/** The longest native name (`NATIVE_NAME`). */
const MAX_NAME = 64

/** The longest tool description the model reads, in characters. */
export const MAX_DESCRIPTION = 1024

/** The longest description or title inside a schema, in characters. */
const MAX_SCHEMA_TEXT = 512

/** The largest input schema offered, as JSON, in characters, measured once its words are cut. */
const MAX_SCHEMA = 65_536

/** The deepest a schema may nest. */
const MAX_DEPTH = 24

/** The most nodes a schema may have once its definitions are inlined: a reference can multiply a small schema. */
const MAX_NODES = 20_000

/** How many items and keys a value in a schema (`enum`, `const`, `default`, `examples`) may have, and how long a string. */
const MAX_VALUES = 256
const MAX_VALUE_TEXT = 512
/** How many `examples` are kept. */
const MAX_EXAMPLES = 3

/**
 * The code points remote text never carries into a tool definition: C0 and C1 controls but tab and line feed, soft
 * hyphens, the Arabic letter and Mongolian vowel marks, zero-width marks, line and paragraph separators, bidirectional
 * overrides, variation selectors, tag characters and lone surrogates, which can hide words or reorder what the model
 * reads.
 */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x06_1c, 0x06_1c],
  [0x18_0e, 0x18_0e],
  [0x20_0b, 0x20_0f],
  [0x20_28, 0x20_2e],
  [0x20_60, 0x20_64],
  [0x20_66, 0x20_69],
  [0xd8_00, 0xdf_ff],
  [0xfe_00, 0xfe_0f],
  [0xfe_ff, 0xfe_ff],
  [0xe_00_00, 0xe_00_7f],
  [0xe_01_00, 0xe_01_ef],
]

const hidden = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0
  return HIDDEN.some(([from, to]) => code >= from && code <= to)
}

/** `text` without its hidden characters, as code points (so no surrogate is ever left alone). */
const unhidden = (text: string): string[] => Array.from(text).filter((char) => !hidden(char))

/** `text` without hidden characters, at most `max` code points, ending in `…` when cut. */
export const cleanText = (text: string, max: number): string => {
  const chars = unhidden(text)
  while (chars.length > 0 && /\s/u.test(chars[0] ?? '')) chars.shift()
  while (chars.length > 0 && /\s/u.test(chars.at(-1) ?? '')) chars.pop()
  if (chars.length <= max) return chars.join('')
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`
}

/** A short, stable hash of `text`: FNV-1a, in base 36. Not a secret, only a tie-breaker between names. */
export const shortHash = (text: string, length: number): string => {
  let hash = 0x81_1c_9d_c5
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0
  }
  return hash.toString(36).padStart(length, '0').slice(-length)
}

/**
 * A server's alias, from the name it gives itself (`serverInfo.name`) or what names it otherwise: lower case,
 * `[a-z0-9_-]` only, no run of `_` (so it never holds the separator), at most 20 characters; `mcp` when nothing is
 * left.
 */
export const aliasOf = (name: string): string => {
  const alias = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, '_')
    .replaceAll(/_+/gu, '_')
    .replaceAll(/^[_-]+|[_-]+$/gu, '')
    .slice(0, MAX_ALIAS)
    .replaceAll(/[_-]+$/gu, '')
  return alias === '' ? 'mcp' : alias
}

/** `alias` with a short hash of what it stands for, when two servers would share it; still at most 20 characters. */
export const suffixedAlias = (alias: string, of: string): string =>
  `${alias.slice(0, MAX_ALIAS - 5).replaceAll(/[_-]+$/gu, '')}_${shortHash(of, 4)}`

/**
 * The native name of `tool` on the server called `alias`: `<alias>__<tool>`, the tool's name with every character
 * outside `[A-Za-z0-9_-]` as `_`; over 64 characters, cut and ended with a hash of the whole, so it stays unique.
 */
export const nativeName = (alias: string, tool: string): string => {
  const whole = `${alias}${SEPARATOR}${tool.replaceAll(/[^A-Za-z0-9_-]/gu, '_')}`
  if (whole.length <= MAX_NAME) return whole
  return `${whole.slice(0, MAX_NAME - 7)}_${shortHash(`${alias}\n${tool}`, 6)}`
}

/** Why a remote tool is not offered natively. */
export type Refusal = 'collision' | 'schema' | 'schema_too_large' | 'name' | 'set_too_large'

/** The definitions a schema's local references name (`#/$defs/<name>`, or the older `#/definitions/<name>`). */
type Definitions = Readonly<Record<string, JsonValue>>

const definitionName = (ref: string): string | undefined =>
  ref.startsWith('#/$defs/')
    ? ref.slice('#/$defs/'.length)
    : ref.startsWith('#/definitions/')
      ? ref.slice('#/definitions/'.length)
      : undefined

/**
 * What one walk of a schema shares: its definitions, the references it is inside, how many nodes it made, and why it
 * was refused, once it was: every step after that answers `null` and stops.
 */
type Walk = {
  readonly definitions: Definitions
  readonly inside: readonly string[]
  readonly state: { nodes: number; refused?: Refusal }
}

/** Refuses the walk's schema for `refusal`, the first refusal standing. */
const refuse = (walk: Walk, refusal: Refusal): null => {
  walk.state.refused ??= refusal
  return null
}

/** Counts one node; refused past the bound, or too deep. Whether the walk goes on. */
const step = (walk: Walk, depth: number): boolean => {
  walk.state.nodes += 1
  if (walk.state.nodes > MAX_NODES) refuse(walk, 'schema_too_large')
  else if (depth > MAX_DEPTH) refuse(walk, 'schema')
  return walk.state.refused === undefined
}

/**
 * A value inside a schema that is data, not schema (`enum`, `const`, `default`, `examples`), cleaned: hidden
 * characters dropped, every key kept (`format` too). `strict` refuses one over its bounds, which would change what the
 * schema allows; otherwise it is cut to them.
 */
function cleanValue(value: JsonValue, strict: boolean, walk: Walk, depth: number): JsonValue {
  if (!step(walk, depth)) return null
  if (typeof value === 'string') {
    const chars = unhidden(value)
    return chars.length > MAX_VALUE_TEXT && strict ? refuse(walk, 'schema') : chars.slice(0, MAX_VALUE_TEXT).join('')
  }
  if (Array.isArray(value))
    return value.length > MAX_VALUES && strict
      ? refuse(walk, 'schema')
      : value.slice(0, MAX_VALUES).map((item) => cleanValue(item, strict, walk, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value)
  if (entries.length > MAX_VALUES && strict) return refuse(walk, 'schema')
  return Object.fromEntries(
    entries
      .slice(0, MAX_VALUES)
      .map(([key, item]) => [unhidden(key).join(''), cleanValue(item, strict, walk, depth + 1)]),
  )
}

/** One keyword of a schema object, cleaned; `undefined` leaves it out. */
function cleanKeyword(key: string, item: JsonValue, walk: Walk, depth: number): JsonValue | undefined {
  if (key === '$schema' || key === '$id' || key === '$defs' || key === 'definitions') return undefined
  // An annotation (JSON Schema 2020-12) TypeBox would enforce: goblin checks no more than the server would (ADR 0092).
  if (key === 'format' && typeof item === 'string') return undefined
  if ((key === 'description' || key === 'title') && typeof item === 'string') return cleanText(item, MAX_SCHEMA_TEXT)
  if (key === 'enum' || key === 'const') return cleanValue(item, true, walk, depth + 1)
  if (key === 'default') return cleanValue(item, false, walk, depth + 1)
  if (key === 'examples')
    return Array.isArray(item)
      ? item.slice(0, MAX_EXAMPLES).map((one) => cleanValue(one, false, walk, depth + 1))
      : undefined
  return cleanSchema(item, walk, depth + 1)
}

/** A schema object, cleaned: a local reference inlined (one inside itself is refused), every keyword cleaned. */
function cleanObject(value: JsonObject, walk: Walk, depth: number): JsonValue {
  const name = typeof value['$ref'] === 'string' ? definitionName(value['$ref']) : undefined
  if (name !== undefined) {
    const target = walk.definitions[name]
    // A reference inside itself would inline without end.
    if (target === undefined || walk.inside.includes(name)) return refuse(walk, 'schema')
    return cleanSchema(target, { ...walk, inside: [...walk.inside, name] }, depth + 1)
  }
  const entries: [string, JsonValue][] = []
  for (const [key, item] of Object.entries(value)) {
    const cleaned = cleanKeyword(key, item, walk, depth)
    if (walk.state.refused !== undefined) return null
    if (cleaned !== undefined) entries.push([unhidden(key).join(''), cleaned])
  }
  return Object.fromEntries(entries)
}

/**
 * A schema value, cleaned: local references inlined with a cycle guard and a bound on what they make, descriptions
 * and titles bounded, values bounded, hidden characters dropped from every string and key, and no `format` or document
 * keys. A refusal is recorded on the walk.
 */
function cleanSchema(value: JsonValue, walk: Walk, depth: number): JsonValue {
  if (!step(walk, depth)) return null
  if (typeof value === 'string') return unhidden(value).join('')
  if (Array.isArray(value)) return value.map((item) => cleanSchema(item, walk, depth + 1))
  if (value === null || typeof value !== 'object') return value
  return cleanObject(value, walk, depth)
}

const recordOf = (value: JsonValue | undefined): Definitions =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}

/**
 * A remote input schema as a native tool's parameters, or why it cannot be one: cleaned and made self-contained
 * (`cleanSchema`), an object, at most {@link MAX_SCHEMA} characters once its words are cut, with no reference left
 * that TypeBox would take but never match, and compiled by TypeBox as Pi will compile it to check each call's
 * arguments. A schema that does not compile is refused rather than offered unchecked.
 */
export const nativeSchema = (schema: unknown): JsonSchema | Refusal => {
  if (!isRecord(schema)) return 'schema'
  // SAFETY: an MCP tool's input schema arrives as JSON, in the server's `tools/list` response.
  const json = schema as JsonObject
  const definitions = { ...recordOf(json['definitions']), ...recordOf(json['$defs']) }
  const walk: Walk = { definitions, inside: [], state: { nodes: 0 } }
  const parameters = cleanSchema(json, walk, 0)
  if (walk.state.refused !== undefined) return walk.state.refused
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) return 'schema'
  if (parameters['type'] !== 'object') return 'schema'
  const text = JSON.stringify(parameters)
  if (text.length > MAX_SCHEMA) return 'schema_too_large'
  if (text.includes('"$ref"')) return 'schema'
  try {
    Compile(parameters)
  } catch {
    // expected: a schema TypeBox cannot compile would fail every call Pi checks against it, so it is not offered.
    return 'schema'
  }
  return parameters
}
