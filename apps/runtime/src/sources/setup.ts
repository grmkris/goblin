// A Source's setup checked against what its connection offers (ADR 0066): its event (which goblin must be able to
// subscribe to by poll and webhook), its tools, each pointer against the event's payload schema or the read tool's
// output schema when the server gives one, and the reply's result rules against the reply tool's (ADR 0096). The
// templates' placeholders are checked by the contract itself.
import type { SourceMatch, SourceSetup } from '@goblin/contracts'
import type { Tool } from '@modelcontextprotocol/client'
import type { EventDescriptor } from '../mcp/events/protocol.ts'
import { isRecord } from '../runtime/digest.ts'
import { type SchemaAt, itemsAt, schemaAt } from './pointer.ts'

/** What a connection offers a Source: its event streams and its tools. */
type Offered = {
  readonly events: readonly EventDescriptor[]
  readonly tools: readonly Pick<Tool, 'name' | 'outputSchema'>[]
}

/** The pointers a setup reads each message with, named as the owner reads them. */
const messagePointers = (setup: SourceSetup): readonly (readonly [string, string])[] => [
  ...setup.key.map((part) => [`key.${part.name}`, part.pointer] as const),
  ...('pointer' in setup.speaksForMe ? [['speaksForMe', setup.speaksForMe.pointer] as const] : []),
  ['read.text', setup.read.text],
  ...(setup.read.id === undefined ? [] : [['read.id', setup.read.id] as const]),
  ...(setup.read.title === undefined ? [] : [['read.title', setup.read.title] as const]),
  ...(setup.read.attachments === undefined ? [] : [['read.attachments', setup.read.attachments] as const]),
  ...(setup.read.direction === undefined ? [] : [['read.direction', setup.read.direction.pointer] as const]),
]

/** The schema of one message, as the event's payload schema or the read tool's output schema describes it. */
function messageSchema(setup: SourceSetup, event: EventDescriptor, tool: Offered['tools'][number] | undefined) {
  const { read } = setup
  if (read.from === 'payload' && read.items === undefined)
    return { list: undefined, message: schemaAt(event.payloadSchema, '') }
  const schema = read.from === 'payload' ? event.payloadSchema : tool?.outputSchema
  return { list: read.items, message: itemsAt(schema, read.items ?? '') }
}

/** What the owner reads of a tool the connection does not offer. */
const missing = (name: string) => `The connection does not offer the tool ${name}.`

/** How many of a value's allowed choices, and of a schema's fields that have some, a problem names. */
const NAMED = 6

/** A value as a problem names it: its JSON, cut short. */
const shown = (value: unknown): string => {
  const json = JSON.stringify(value) ?? String(value)
  return json.length <= 40 ? json : `${json.slice(0, 39)}…`
}

/**
 * The values a schema allows, when it lists them: its `enum`, its `const`, or those of every branch of its `anyOf` or
 * `oneOf` when each branch lists its own. None when any part of it allows more.
 */
function allowedOf(schema: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  const listed: unknown = schema['enum']
  if (Array.isArray(listed)) return listed.map((value: unknown) => value)
  if ('const' in schema) return [schema['const']]
  const branches = [schema['anyOf'], schema['oneOf']].find(Array.isArray)
  if (branches === undefined || branches.length === 0) return undefined
  const lists = branches.map((branch: unknown) => (isRecord(branch) ? allowedOf(branch) : undefined))
  return lists.every((list) => list !== undefined) ? lists.flat() : undefined
}

/** The fields of an output schema, at most two levels down, that list the values they allow: `/status` (`"sent"`, …). */
function choicesOf(schema: unknown, at = '', depth = 0): readonly string[] {
  if (!isRecord(schema) || depth > 1 || !isRecord(schema['properties'])) return []
  return Object.entries(schema['properties']).flatMap(([field, child]) => {
    const pointer = `${at}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`
    const allowed = isRecord(child) ? allowedOf(child) : undefined
    if (allowed !== undefined) return [`${pointer} (${allowed.slice(0, NAMED).map(shown).join(', ')})`]
    return choicesOf(child, pointer, depth + 1)
  })
}

/** Why a rule's value is not one the pointed schema allows, when it lists the values it allows. */
function equalsProblem(name: string, rule: SourceMatch, at: SchemaAt): string | undefined {
  if (at.at !== 'known') return undefined
  const allowed = allowedOf(at.schema)
  if (allowed === undefined || allowed.some((value) => value === rule.equals)) return undefined
  const choices = allowed.slice(0, NAMED).map(shown).join(', ')
  return `reply.result.${name} equals ${shown(rule.equals)}, which ${rule.pointer} never is: it is one of ${choices}.`
}

/**
 * Result rules checked against the reply tool's structured output schema when it declares one (ADRs 0072, 0096): then
 * rules are required, since without them every answer sent is an unknown outcome the owner is told about; each pointer
 * must be in the schema, and each value one the pointed field allows when it lists them.
 */
function resultProblems(reply: SourceSetup['reply'], offered: Offered): readonly string[] {
  if (reply === undefined) return []
  const schema = offered.tools.find((each) => each.name === reply.tool)?.outputSchema
  if (reply.result === undefined) {
    if (schema === undefined) return []
    const choices = choicesOf(schema).slice(0, NAMED)
    const hint = choices.length === 0 ? '' : ` Its output schema lists ${choices.join('; ')}.`
    return [
      `reply.result is required: ${reply.tool} declares an output schema, so say which value of its result means the answer was accepted (and which mean retryable or rejected, when it has them).${hint}`,
    ]
  }
  return Object.entries(reply.result).flatMap(([name, rule]) => {
    const pointer = typeof rule === 'string' ? rule : rule.pointer
    const at = schemaAt(schema, pointer)
    if (at.at === 'absent')
      return [`reply.result.${name} points at ${pointer}, which the tool's output schema does not have.`]
    const problem = typeof rule === 'string' ? undefined : equalsProblem(name, rule, at)
    return problem === undefined ? [] : [problem]
  })
}

/** Why the setup's tools do not hold: each one the connection does not offer, and a read cursor its schema lacks. */
function toolProblems(setup: SourceSetup, offered: Offered): readonly string[] {
  const toolNamed = (name: string) => offered.tools.find((each) => each.name === name)
  const problems: string[] = []
  const { read, reply } = setup
  if (read.from === 'tool') {
    const tool = toolNamed(read.tool)
    if (tool === undefined) problems.push(missing(read.tool))
    else if (schemaAt(tool.outputSchema, read.cursor).at === 'absent')
      problems.push(`read.cursor points at ${read.cursor}, which the tool's output schema does not have.`)
  }
  if (reply !== undefined && toolNamed(reply.tool) === undefined) problems.push(missing(reply.tool))
  return [...problems, ...resultProblems(reply, offered)]
}

/** Why the setup's pointers into a message do not hold where the server's schema says what a message is. */
function pointerProblems(setup: SourceSetup, found: { readonly list: string | undefined; readonly message: SchemaAt }) {
  const { list, message } = found
  if (list !== undefined && message.at === 'absent')
    return [`read.items points at ${list}, which is not a list in the server's schema.`]
  if (message.at !== 'known') return []
  return messagePointers(setup)
    .filter(([, pointer]) => schemaAt(message.schema, pointer).at === 'absent')
    .map(([what, pointer]) => `${what} points at ${pointer}, which the server's schema does not have.`)
}

/** The tool a setup reads from, as the connection offers it; none for a read of the event's data. */
const readToolOf = (setup: SourceSetup, offered: Offered) => {
  const { read } = setup
  return read.from === 'tool' ? offered.tools.find((each) => each.name === read.tool) : undefined
}

/**
 * Why `setup` does not hold on a connection that offers `offered`; none when it does. A pointer is refused only where
 * the server's schema says there is no such value; a schema that says nothing lets it be.
 */
export function setupProblems(setup: SourceSetup, offered: Offered): readonly string[] {
  const event = offered.events.find((each) => each.name === setup.wake.event)
  if (event === undefined) return [`The connection does not offer the event ${setup.wake.event}.`]
  const subscribable = event.delivery.includes('poll') && event.delivery.includes('webhook')
  return [
    ...(subscribable ? [] : [`goblin cannot subscribe to ${event.name}: it needs both poll and webhook delivery.`]),
    ...toolProblems(setup, offered),
    ...pointerProblems(setup, messageSchema(setup, event, readToolOf(setup, offered))),
  ]
}
