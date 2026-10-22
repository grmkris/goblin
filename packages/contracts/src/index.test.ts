import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  ClientErrorReport,
  ConversationView,
  CreateConversation,
  FilePath,
  PersonaName,
  PlainSend,
  RunInput,
  StartThread,
  UpdatePersona,
  WorkspaceChange,
  personaAnswerText,
  runInput,
  selectionKey,
  threadStart,
} from './index.ts'

const ok = (path: string) => Schema.is(FilePath)(path)

describe('file paths', () => {
  it('accept plain names under the two areas', () => {
    expect(ok('/uploads/sales.csv')).toBe(true)
    expect(ok('/agent/reports/Poročilo (2).md')).toBe(true)
  })
  it('refuse other roots, dot segments, separators and empty segments', () => {
    expect(ok('/etc/passwd')).toBe(false)
    expect(ok('/uploads')).toBe(false)
    expect(ok('/uploads/../agent/x')).toBe(false)
    expect(ok('/uploads/./x')).toBe(false)
    expect(ok('/uploads//x')).toBe(false)
    expect(ok('/uploads/a\\b')).toBe(false)
    expect(ok('/uploads/a:b')).toBe(false)
  })
})

describe('topics, personas and threads', () => {
  const topic = {
    id: 2,
    name: 'Japan trip',
    conversation: '17',
    searchExcluded: false,
    revision: 1,
    setup: { mcpServers: [{ connectionId: 'notes', tools: ['read'] }], skills: 'all', apps: [], subagents: false },
    createdBy: 'agent',
    createdAt: 1,
  }
  it('carries a Topic change through the workspace feed', () => {
    expect(Schema.decodeUnknownSync(WorkspaceChange)({ type: 'topic', topic })).toEqual({ type: 'topic', topic })
  })
  it('reads a conversation from a server older than Topics', () => {
    const old = { id: '1', kind: 'main', createdAt: 1, keepOpen: false, replies: 0 }
    expect(Schema.decodeUnknownSync(ConversationView)(old).topic).toBeUndefined()
  })
  it('names Personas as the composer tags them', () => {
    const named = Schema.is(PersonaName)
    expect(named('Scout')).toBe(true)
    expect(named('Code reviewer-2')).toBe(true)
    expect(named('2fast')).toBe(false)
    expect(named('@scout')).toBe(false)
    expect(named('x'.repeat(33))).toBe(false)
  })
  it('keys a Persona selection apart from other selections', () => {
    expect(selectionKey({ kind: 'persona', personaId: 3 })).toBe('persona:3')
  })
  it('refuses a Persona update without the revision it edits', () => {
    expect(Schema.is(UpdatePersona)({ name: 'Scout' })).toBe(false)
    expect(Schema.is(UpdatePersona)({ name: 'Scout', expectedRevision: 2 })).toBe(true)
  })
  it('bounds a plain send like the messages route always did', () => {
    expect(Schema.is(PlainSend)({ input: 'hi', operationId: 'op-1', personaOrder: 'sequence' })).toBe(true)
    expect(Schema.is(PlainSend)({ input: 'x'.repeat(20_001), operationId: 'op-1' })).toBe(false)
  })
})

describe('a send as AG-UI input (ADR 0111)', () => {
  const selections = [{ kind: 'persona' as const, personaId: 3 }]
  it('makes one user message under the operation id, with goblin parts only when there are any', () => {
    expect(runInput('7', { input: 'hi', operationId: 'op-1' })).toEqual({
      threadId: '7',
      runId: 'op-1',
      messages: [{ id: 'op-1', role: 'user', content: 'hi' }],
    })
    const tagged = runInput('7', { input: 'hi', operationId: 'op-1', selections, attachments: [], appContext: [] })
    expect(tagged.forwardedProps).toEqual({ goblin: { selections } })
    expect(Schema.is(RunInput)(tagged)).toBe(true)
  })
  it('takes any history and ignores keys goblin does not read, but bounds the run id and its parts', () => {
    const decode = Schema.decodeUnknownSync(RunInput)
    const input = { threadId: '7', runId: 'op-1', messages: [{ anything: true }], forwardedProps: { other: 1 } }
    expect(decode({ ...input, context: [], tools: [], state: {} }).forwardedProps).toEqual({})
    expect(Schema.is(RunInput)({ ...input, runId: 'x'.repeat(201) })).toBe(false)
    expect(Schema.is(RunInput)({ ...input, forwardedProps: { goblin: { attachments: ['/etc/passwd'] } } })).toBe(false)
    expect(Schema.is(RunInput)({ ...input, resume: [{ interruptId: '7:i3', status: 'answered' }] })).toBe(false)
  })
})

describe('thread operations', () => {
  it('keeps a create without an operation id valid and accepts one', () => {
    expect(Schema.is(CreateConversation)({ topic: 2 })).toBe(true)
    expect(Schema.is(CreateConversation)({ operationId: 'op-1', from: { conversation: '3', entry: 9 } })).toBe(true)
  })
  it('starts a thread from an entry, empty or the latest entry, its first message a send', () => {
    const message = runInput('2', { input: 'hi', operationId: 'op-1', selections: [{ kind: 'persona', personaId: 3 }] })
    expect(Schema.is(StartThread)({ anchor: { entry: 9 }, message })).toBe(true)
    expect(Schema.is(StartThread)({ anchor: 'latest', message })).toBe(true)
    expect(Schema.is(StartThread)({ anchor: { entry: 0 }, message })).toBe(false)
    expect(Schema.is(StartThread)({ anchor: 'empty', message: { ...message, runId: '' } })).toBe(false)
  })
  it('makes the body of a plain thread operation, its Persona order with the first message', () => {
    const start = threadStart('2', {
      operationId: 'op-1',
      anchor: 'empty',
      title: 'Plan',
      message: { input: 'hi', selections: [{ kind: 'persona', personaId: 3 }] },
      personaOrder: 'sequence',
    })
    expect(start).toEqual({
      anchor: 'empty',
      title: 'Plan',
      message: runInput('2', {
        input: 'hi',
        operationId: 'op-1',
        selections: [{ kind: 'persona', personaId: 3 }],
        personaOrder: 'sequence',
      }),
    })
  })
})

describe('client error reports', () => {
  const report = {
    route: '/c/$chatId',
    name: 'TypeError',
    frames: ['https://goblin.surf/assets/index-3f2a.js:1:2345'],
    build: 'd5ac526',
    ref: '7f3a9c12',
  }
  const valid = Schema.is(ClientErrorReport)
  it('accepts a route template, a class name, locations and a build', () => {
    expect(valid(report)).toBe(true)
  })
  it('refuses anything that could carry a message', () => {
    expect(valid({ ...report, name: 'Cannot read x of undefined' })).toBe(false)
    expect(valid({ ...report, route: '/c/1?q=my secret' })).toBe(false)
    expect(valid({ ...report, frames: ['at render (index.js:1:2)'] })).toBe(false)
    expect(valid({ ...report, frames: ['secret words'] })).toBe(false)
    expect(valid({ ...report, build: 'a b' })).toBe(false)
  })
  it('bounds the frames and the whole report', () => {
    expect(valid({ ...report, frames: Array.from({ length: 13 }, () => 'index.js:1:2') })).toBe(false)
    const long = `https://goblin.surf/${'a'.repeat(270)}.js:1:2`
    expect(valid({ ...report, frames: Array.from({ length: 12 }, () => long) })).toBe(false)
  })
})

describe("a Persona's answer as plain text (ADR 0082)", () => {
  const questions = [
    {
      id: 'size',
      prompt: 'Which size?',
      kind: 'single' as const,
      options: [
        { id: 'square', label: 'Square', description: '3000 × 3000' },
        { id: 'tall', label: 'Tall' },
      ],
      allowOther: true,
    },
    { id: 'tone', prompt: 'Any tone to keep?', kind: 'text' as const },
  ]
  it('is its words when it asked nothing', () => {
    expect(personaAnswerText({ text: 'Done.' })).toBe('Done.')
  })
  it('numbers what it asked after its words, or alone', () => {
    const asked =
      'Asked:\n1. Which size?\n   - Square (3000 × 3000)\n   - Tall\n   - or something else\n2. Any tone to keep?'
    expect(personaAnswerText({ text: 'Two things first.', questions })).toBe(`Two things first.\n\n${asked}`)
    expect(personaAnswerText({ text: '', questions })).toBe(asked)
  })
})
