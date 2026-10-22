import type { JsonValue } from '@goblin/contracts'
import { Compile } from 'typebox/compile'
import { isRecord } from '../runtime/digest.ts'
import { type JsonSchema, selfContained } from './typed-tool.ts'

// A Persona fork's native MCP tools (ADR 0101): one naming rule for every app's tools, `<server>__<tool>`, and the remote
// words and schemas the model reads as its own, bounded and cleaned. Pure: the set's builder (`pi/fork-tools.ts`)
// reads the connections, scope and grants.

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

/** The largest input schema offered, as JSON, in characters. */
export const MAX_SCHEMA = 16_384

/** The deepest a schema may nest. */
const MAX_DEPTH = 24

/**
 * The code points remote text never carries into a tool definition: C0 and C1 controls but tab and line feed,
 * zero-width marks and bidirectional overrides, which can hide words or reorder what the model reads.
 */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x20_0b, 0x20_0f],
  [0x20_2a, 0x20_2e],
  [0x20_60, 0x20_64],
  [0x20_66, 0x20_69],
  [0xfe_ff, 0xfe_ff],
]

/** `text` without its hidden characters. */
const unhidden = (text: string): string =>
  Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return !HIDDEN.some(([from, to]) => code >= from && code <= to)
    })
    .join('')

/** `text` without hidden characters, at most `max` characters, ending in `…` when cut. */
export const cleanText = (text: string, max: number): string => {
  const clean = unhidden(text).trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
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
export type Refusal = 'collision' | 'schema' | 'schema_too_large' | 'name'

/** A schema's array, each item cleaned; refused when one is. */
const cleanArray = (items: readonly JsonValue[], depth: number): JsonValue | undefined => {
  const cleaned: JsonValue[] = []
  for (const item of items) {
    const each = cleanSchema(item, depth + 1)
    if (each === undefined) return undefined
    cleaned.push(each)
  }
  return cleaned
}

/** One keyword of a schema object, cleaned: a description or title bounded, anything else as `cleanSchema` cleans it. */
const cleanEntry = (key: string, item: JsonValue, depth: number): JsonValue | undefined =>
  (key === 'description' || key === 'title') && typeof item === 'string'
    ? cleanText(item, MAX_SCHEMA_TEXT)
    : cleanSchema(item, depth + 1)

/** A schema's object, each keyword cleaned and without `format`; refused when one is. */
const cleanObject = (value: { readonly [key: string]: JsonValue }, depth: number): JsonValue | undefined => {
  const entries: [string, JsonValue][] = []
  for (const [key, item] of Object.entries(value)) {
    if (key === 'format' && typeof item === 'string') continue
    const cleaned = cleanEntry(key, item, depth)
    if (cleaned === undefined) return undefined
    entries.push([unhidden(key), cleaned])
  }
  return Object.fromEntries(entries)
}

/**
 * A schema value with its words cleaned: descriptions and titles bounded, hidden characters dropped from every string
 * and key, and no `format` (JSON Schema 2020-12 makes it an annotation, which TypeBox would enforce: goblin checks no
 * more than the server would, ADR 0092). Too deep is refused (`undefined`).
 */
function cleanSchema(value: JsonValue, depth = 0): JsonValue | undefined {
  if (depth > MAX_DEPTH) return undefined
  if (typeof value === 'string') return unhidden(value)
  if (Array.isArray(value)) return cleanArray(value, depth)
  if (value === null || typeof value !== 'object') return value
  return cleanObject(value, depth)
}

/** Keywords a tool's parameters leave out: what names the document, which providers and TypeBox do not need. */
const DOCUMENT_KEYS = new Set(['$schema', '$id', '$defs', 'definitions'])

/**
 * A remote input schema as a native tool's parameters, or why it cannot be one: cleaned, made self-contained (its
 * `#/$defs` references inlined, as goblin's own tools are, since providers differ on `$ref`), an object, at most
 * {@link MAX_SCHEMA} characters, and compiled by TypeBox as Pi will compile it to check each call's arguments. A schema
 * that does not compile is refused rather than offered unchecked.
 */
export const nativeSchema = (schema: unknown): JsonSchema | Refusal => {
  if (!isRecord(schema)) return 'schema'
  // SAFETY: an MCP tool's input schema arrives as JSON, in the server's `tools/list` response.
  const cleaned = cleanSchema(schema as JsonValue)
  if (typeof cleaned !== 'object' || cleaned === null || Array.isArray(cleaned)) return 'schema'
  const whole = selfContained(cleaned)
  const parameters = Object.fromEntries(Object.entries(whole).filter(([key]) => !DOCUMENT_KEYS.has(key)))
  if (parameters['type'] !== 'object') return 'schema'
  const text = JSON.stringify(parameters)
  if (text.length > MAX_SCHEMA) return 'schema_too_large'
  // A reference left after inlining (another document's, or the whole schema's) is one TypeBox takes but never matches.
  if (text.includes('"$ref"')) return 'schema'
  try {
    Compile(parameters)
  } catch {
    // expected: a schema TypeBox cannot compile would fail every call Pi checks against it, so it is not offered.
    return 'schema'
  }
  return parameters
}
