// A Source's setup checked against what its connection offers (ADR 0066): its event (which goblin must be able to
// subscribe to by poll and webhook), its tools, and each pointer against the event's payload schema or the read tool's
// output schema when the server gives one. The templates' placeholders are checked by the contract itself.
import type { SourceSetup } from '@goblin/contracts'
import type { Tool } from '@modelcontextprotocol/client'
import type { EventDescriptor } from '../mcp/events/protocol.ts'
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
  return problems
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
