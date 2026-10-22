import { SourceSetup } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { schemaAt, valueAt } from '../src/sources/pointer.ts'
import { setupProblems } from '../src/sources/setup.ts'
import { FEED_READ, MAIL_RECEIVED, MAIL_SETUP, POST_CREATED, PAYLOAD_SETUP } from './sources-fixture.ts'

const accepts = Schema.is(SourceSetup)
const offered = { events: [POST_CREATED], tools: [FEED_READ, { name: 'post_reply' }] }

/** A tool read of the inbox from its cursor, as a Source over a chat server's inbox would read it. */
const TOOL_READ = {
  from: 'tool' as const,
  tool: 'feed_read',
  arguments: { chat: 'all', cursor: '{{cursor}}' },
  items: '/messages',
  cursor: '/nextCursor',
  id: '/id',
  text: '/text',
}

/** The payload setup with its reply's arguments as `args`. */
const reply = (args: Record<string, unknown>) => ({
  ...PAYLOAD_SETUP,
  reply: { tool: 'post_reply', arguments: args, maxChars: 100 },
})

describe('JSON pointers (RFC 6901)', () => {
  it('reads values through objects and arrays, with ~0 and ~1 escapes', () => {
    const value = { a: [{ 'b/c': { '~d': 1 } }] }
    expect(valueAt(value, '')).toBe(value)
    expect(valueAt(value, '/a/0/b~1c/~0d')).toBe(1)
    expect(valueAt(value, '/a/01')).toBeUndefined()
    expect(valueAt(value, '/missing')).toBeUndefined()
  })

  it("follows a schema's properties, items, local references and branches", () => {
    const schema = {
      type: 'object',
      properties: { list: { type: 'array', items: { $ref: '#/$defs/item' } } },
      $defs: { item: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }] } },
    }
    expect(schemaAt(schema, '/list/0/a').at).toBe('known')
    expect(schemaAt(schema, '/list/0/b').at).toBe('absent')
    expect(schemaAt(schema, '/other').at).toBe('absent')
    expect(schemaAt({ type: 'object', additionalProperties: true, properties: {} }, '/other').at).toBe('open')
    expect(schemaAt(undefined, '/anything').at).toBe('open')
  })
})

describe("a Source's setup (ADR 0066)", () => {
  it('holds when every pointer is in the event payload schema and the tools are offered', () => {
    expect(accepts(PAYLOAD_SETUP)).toBe(true)
    expect(setupProblems(PAYLOAD_SETUP, offered)).toEqual([])
  })

  it("refuses a pointer the server's schema says is not there, and names it", () => {
    const { reply: _, ...noReply } = PAYLOAD_SETUP
    expect(setupProblems({ ...noReply, key: [{ name: 'room', pointer: '/room' }] }, offered)).toEqual([
      "key.room points at /room, which the server's schema does not have.",
    ])
    const speaks = { ...PAYLOAD_SETUP, speaksForMe: { pointer: '/author/role', equals: 'owner' } }
    expect(setupProblems(speaks, offered)).toEqual([
      "speaksForMe points at /author/role, which the server's schema does not have.",
    ])
  })

  it("holds for mail read from its event's data, with no tool, no cursor and no reply", () => {
    const mailbox = { events: [MAIL_RECEIVED], tools: [] }
    expect(accepts(MAIL_SETUP)).toBe(true)
    expect(setupProblems(MAIL_SETUP, mailbox)).toEqual([])
    const named = { ...MAIL_SETUP, speaksForMe: { pointer: '/from/name', equals: 'Me' } }
    expect(setupProblems(named, mailbox)).toEqual([
      "speaksForMe points at /from/name, which the server's schema does not have.",
    ])
  })

  it("checks a tool read's items and cursor against the tool's output schema", () => {
    expect(setupProblems({ ...PAYLOAD_SETUP, read: TOOL_READ }, offered)).toEqual([])
    const wrong = { ...TOOL_READ, items: '/entries', cursor: '/next' }
    expect(setupProblems({ ...PAYLOAD_SETUP, read: wrong }, offered)).toEqual([
      "read.cursor points at /next, which the tool's output schema does not have.",
      "read.items points at /entries, which is not a list in the server's schema.",
    ])
  })

  it('names an event or a tool the connection does not offer', () => {
    expect(setupProblems({ ...PAYLOAD_SETUP, wake: { event: 'mail.received', arguments: {} } }, offered)).toEqual([
      'The connection does not offer the event mail.received.',
    ])
    const mail = { tool: 'mail_send', arguments: { text: '{{text}}' }, maxChars: 100 }
    expect(setupProblems({ ...PAYLOAD_SETUP, reply: mail }, offered)).toEqual([
      'The connection does not offer the tool mail_send.',
    ])
  })

  it('takes placeholders only as whole string values, and only the ones its use names', () => {
    expect(accepts(reply({ text: 'Re: {{text}}' }))).toBe(false)
    expect(accepts(reply({ text: '{{text}}', chat: '{{key.room}}' }))).toBe(false)
    expect(accepts(reply({ chat: '{{key.chat}}' }))).toBe(false)
    expect(accepts(reply({ text: '{{text}}', nested: { to: ['{{key.chat}}'] } }))).toBe(true)
    expect(accepts({ ...PAYLOAD_SETUP, read: { ...TOOL_READ, arguments: { chat: 'all' } } })).toBe(false)
    expect(
      accepts({ ...PAYLOAD_SETUP, read: { ...TOOL_READ, arguments: { cursor: '{{cursor}}', text: '{{text}}' } } }),
    ).toBe(false)
  })
})
