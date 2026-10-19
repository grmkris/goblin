// RFC 6901 JSON pointers as Sources read them (ADR 0066): the value a pointer names in a message, and what a server's
// JSON schema says is there, so a proposal's pointers are checked against the schema before the owner confirms it.
import { isRecord } from '../runtime/digest.ts'

/** A pointer's reference tokens, unescaped (`~1` is `/`, `~0` is `~`); none for the whole value. */
const tokensOf = (pointer: string): readonly string[] =>
  pointer === ''
    ? []
    : pointer
        .slice(1)
        .split('/')
        .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))

/** An array index as RFC 6901 writes one: digits with no leading zero. */
const INDEX = /^(?:0|[1-9]\d*)$/u

/** The value `pointer` names in `value`, or undefined when there is none. */
export function valueAt(value: unknown, pointer: string): unknown {
  let at = value
  for (const token of tokensOf(pointer)) {
    if (Array.isArray(at)) {
      if (!INDEX.test(token)) return undefined
      at = at[Number(token)]
    } else if (isRecord(at) && Object.hasOwn(at, token)) at = at[token]
    else return undefined
  }
  return at
}

/**
 * What a JSON schema says about the value at a pointer: its schema (`known`), nothing either way (`open`: no schema, a
 * reference goblin cannot follow, or a value that may hold more), or that there is no such value (`absent`).
 */
export type SchemaAt =
  | { readonly at: 'known'; readonly schema: Readonly<Record<string, unknown>> }
  | { readonly at: 'open' }
  | { readonly at: 'absent' }

const OPEN: SchemaAt = { at: 'open' }
const ABSENT: SchemaAt = { at: 'absent' }
const known = (schema: unknown): SchemaAt => (isRecord(schema) ? { at: 'known', schema } : OPEN)

/** How deep a schema is followed, so a reference that points back at itself ends. */
const MAX_DEPTH = 32

const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const COMBINATORS = ['allOf', 'anyOf', 'oneOf']
const STRUCTURE = ['type', 'properties', 'items', 'prefixItems', 'additionalProperties', 'patternProperties']

/** The schemas `schema` combines: the members of its `allOf`, `anyOf` and `oneOf`, in that order. */
const combined = (schema: Readonly<Record<string, unknown>>): readonly unknown[] =>
  COMBINATORS.flatMap((key): unknown[] => (Array.isArray(schema[key]) ? schema[key] : []))

/**
 * The schema's own branches: itself (unless it only combines others), and those of `allOf`, `anyOf` and `oneOf`, with
 * a local `$ref` followed.
 */
function branches(root: Readonly<Record<string, unknown>>, schema: Readonly<Record<string, unknown>>, depth: number) {
  const found: Readonly<Record<string, unknown>>[] = []
  const visit = (each: unknown, level: number) => {
    if (!isRecord(each) || level > MAX_DEPTH) return
    const ref = each['$ref']
    if (typeof ref === 'string') {
      // Only a reference inside the same schema (`#/$defs/…`) is followed; any other says nothing.
      if (ref.startsWith('#')) visit(valueAt(root, ref.slice(1)), level + 1)
      return
    }
    const combines = COMBINATORS.some((key) => key in each)
    if (!combines || STRUCTURE.some((key) => key in each)) found.push(each)
    for (const branch of combined(each)) visit(branch, level + 1)
  }
  visit(schema, depth)
  return found
}

/** What an array schema says about its element `token`: its tuple's or its items' schema. */
function elementOf(schema: Readonly<Record<string, unknown>>, token: string): SchemaAt {
  if (!INDEX.test(token)) return schema['type'] === 'array' ? ABSENT : OPEN
  const tuple = schema['prefixItems']
  if (Array.isArray(tuple) && Number(token) < tuple.length) return known(tuple[Number(token)])
  const items = schema['items']
  return isRecord(items) ? known(items) : OPEN
}

/**
 * What an object schema says about its field `token`. A schema that lists its properties says what a message holds:
 * a pointer to one it does not list is a mistake, unless it says more may come (`additionalProperties`,
 * `patternProperties`).
 */
function fieldOf(schema: Readonly<Record<string, unknown>>, token: string): SchemaAt {
  const properties = schema['properties']
  if (isRecord(properties) && Object.hasOwn(properties, token)) return known(properties[token])
  const more = schema['additionalProperties']
  if (isRecord(more)) return known(more)
  if (more === false) return ABSENT
  const listed = isRecord(properties) && more === undefined && schema['patternProperties'] === undefined
  return listed ? ABSENT : OPEN
}

/** What one schema (no branches) says about its child `token`. */
function childOf(schema: Readonly<Record<string, unknown>>, token: string): SchemaAt {
  const type = schema['type']
  if (typeof type === 'string' && SCALARS.has(type)) return ABSENT
  return type === 'array' || schema['items'] !== undefined ? elementOf(schema, token) : fieldOf(schema, token)
}

/**
 * What `schema` says is at `pointer`: followed through objects' properties, arrays' items and the branches of `allOf`,
 * `anyOf` and `oneOf` (the value is there when any branch has it, and absent only when every branch says so).
 */
export function schemaAt(schema: unknown, pointer: string): SchemaAt {
  if (!isRecord(schema)) return OPEN
  let current: SchemaAt = known(schema)
  for (const token of tokensOf(pointer)) {
    if (current.at !== 'known') return current
    const answers = branches(schema, current.schema, 0).map((branch) => childOf(branch, token))
    current =
      answers.find((answer) => answer.at === 'known') ??
      (answers.length > 0 && answers.every((answer) => answer.at === 'absent') ? ABSENT : OPEN)
  }
  return current
}

/** What a schema says about each item of the list at `pointer`: the items' schema, or `open` when it says nothing. */
export function itemsAt(schema: unknown, pointer: string): SchemaAt {
  const list = schemaAt(schema, pointer)
  if (list.at !== 'known') return list
  if (!isRecord(schema)) return OPEN
  for (const branch of branches(schema, list.schema, 0)) {
    const type = branch['type']
    if (typeof type === 'string' && type !== 'array') return ABSENT
    if (isRecord(branch['items'])) return known(branch['items'])
  }
  return OPEN
}
