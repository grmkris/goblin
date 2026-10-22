import { describe, expect, it } from 'vitest'
import { DelegateResultData, PersonaAnswerData, PersonaAskData, ThreadHeadData, TopicSeedData } from '@goblin/contracts'
import { Schema } from 'effect'
import { conversationParts } from '../src/lib/conversation-parts.ts'
import { isOwnTurn, samePart } from '../src/lib/parts.ts'
import { activity, answer as reply, said, snapshot } from './agui-fixtures.ts'

// Every fixture's data is the contract's own shape: it decodes with the schema the runtime writes it with.
const head = Schema.decodeUnknownSync(ThreadHeadData)({ thread: '12', text: 'Plan the trip', operationId: 'op-1' })
const moved = Schema.decodeUnknownSync(ThreadHeadData)({
  thread: '13',
  text: 'Compare flights',
  moved: true,
  author: 'Kris',
  operationId: 'op-2',
})
const ask = Schema.decodeUnknownSync(PersonaAskData)({
  personas: [
    { id: 1, name: 'Critic', revision: 2 },
    { id: 2, name: 'Coach', revision: 1 },
  ],
  order: 'sequence',
})
const answer = Schema.decodeUnknownSync(PersonaAnswerData)({
  persona: 1,
  name: 'Critic',
  revision: 2,
  avatar: { glyph: 'C', hue: 20 },
  operationId: 'persona:op-3:1',
  text: 'Too long.',
})
const seed = Schema.decodeUnknownSync(TopicSeedData)({
  brief: 'Japan in April',
  sources: [{ chat: '1', entryStart: 3, entryEnd: 5, excerpt: 'cherry blossoms' }],
})
const result = Schema.decodeUnknownSync(DelegateResultData)({
  delegate: '21',
  name: 'Researcher',
  status: 'done',
  text: 'Three options.',
})

/** A Persona's answer as the stream carries it: an assistant message with its Persona's mark. */
const spoke = (entry: number, data: PersonaAnswerData) => {
  const { persona, text, ...mark } = data
  return reply(entry, { text, at: entry * 1_000, marks: { persona: { id: persona, ...mark } } })
}
const held = (entry: number, persona: number, hold?: object) =>
  spoke(
    entry,
    Schema.decodeUnknownSync(PersonaAnswerData)({
      ...answer,
      persona,
      operationId: `op-${String(entry)}`,
      ...(hold === undefined ? {} : { hold }),
    }),
  )

describe('entries the app writes into a chat', () => {
  it('draws a thread head, a Persona ask and answer, a Topic brief and a Delegate result as their own parts', () => {
    const parts = conversationParts(
      snapshot([
        activity(1, 'goblin.topic_seed', seed),
        activity(2, 'goblin.thread_head', head, { at: 7 }),
        said(3, 'Is this good?', { ask }),
        spoke(4, answer),
        activity(5, 'goblin.delegate_result', result),
      ]),
    )
    expect(parts.map((part) => part.kind)).toEqual([
      'topic-seed',
      'thread-head',
      'persona-ask',
      'persona-answer',
      'delegate-result',
    ])
    expect(parts[0]).toMatchObject({ brief: 'Japan in April', sources: [{ excerpt: 'cherry blossoms' }] })
    expect(parts[1]).toEqual({
      kind: 'thread-head',
      id: '2:0',
      thread: '12',
      text: 'Plan the trip',
      moved: false,
      at: 7,
    })
    expect(parts[2]).toMatchObject({ text: 'Is this good?', order: 'sequence', personas: [{ name: 'Critic' }, {}] })
    expect(parts[3]).toMatchObject({ name: 'Critic', avatar: { glyph: 'C', hue: 20 }, text: 'Too long.' })
    expect(parts[3]).not.toHaveProperty('operationId')
    expect(parts[4]).toMatchObject({ delegate: '21', name: 'Researcher', status: 'done', text: 'Three options.' })
  })

  it("keeps a Persona's hold on its newest answer only: its next answer settles it (ADR 0041)", () => {
    const grant = { kind: 'grant', connectionId: 'sq', name: 'quote', fork: '40' }
    const approval = { kind: 'approval', approvalId: 'mcp:41:c1', connectionId: 'sq', name: 'bid', fork: '41' }
    const parts = conversationParts(snapshot([held(1, 1, grant), held(2, 2, approval), held(3, 1), held(4, 1, grant)]))
    expect(parts.map((part) => (part.kind === 'persona-answer' ? [part.persona, part.hold?.kind] : []))).toEqual([
      [1, undefined],
      [2, 'approval'],
      [1, undefined],
      [1, 'grant'],
    ])
  })

  it("draws a routine's notice from its connection, never as the owner's turn (ADR 0041)", () => {
    const notice = {
      notice: 'notice:rt_1:evt-1',
      routine: 'rt_1',
      source: 'event',
      from: { connectionId: 'sidequest-worker', label: 'Sidequest · Worker' },
      title: 'You were picked',
      body: 'Job 12: Write docs',
      url: 'https://sidequest.test/jobs/12',
    }
    const [part] = conversationParts(snapshot([activity(6, 'goblin.notice', notice, { at: 9000 })]))
    expect(part).toEqual({
      kind: 'notice',
      id: '6:0',
      source: 'event',
      from: { connectionId: 'sidequest-worker', label: 'Sidequest · Worker' },
      title: 'You were picked',
      body: 'Job 12: Write docs',
      url: 'https://sidequest.test/jobs/12',
      at: 9000,
    })
    expect(part !== undefined && isOwnTurn(part)).toBe(false)
  })

  it("marks a moved turn's head as moved and keeps who wrote it", () => {
    const [part] = conversationParts(snapshot([activity(9, 'goblin.thread_head', moved)]))
    expect(part).toMatchObject({ kind: 'thread-head', thread: '13', moved: true, author: 'Kris' })
  })

  it('leaves out an entry whose data does not have its contract shape', () => {
    const parts = conversationParts(
      snapshot([
        activity(1, 'goblin.thread_head', { thread: 'not digits', text: 'x', operationId: 'op' }),
        reply(2, { text: 'x', marks: { persona: { name: 'nobody' } } }),
        said(3, 'still here'),
      ]),
    )
    expect(parts.map((part) => [part.kind, part.id])).toEqual([['user', '3:0']])
  })

  it("counts the owner's message to Personas as the owner's turn", () => {
    const [part] = conversationParts(snapshot([said(3, 'Hi', { ask })]))
    expect(part !== undefined && isOwnTurn(part)).toBe(true)
  })

  it('draws an unchanged app entry once across batches', () => {
    const messages = [activity(2, 'goblin.thread_head', head)]
    const [first] = conversationParts(snapshot(messages))
    const [again] = conversationParts(snapshot(structuredClone(messages)))
    expect(first !== undefined && again !== undefined && samePart(first, again)).toBe(true)
  })
})

describe('a turn moved out of the chat', () => {
  it('hides the entries a later entry omits, and shows the head in their place', () => {
    const parts = conversationParts(
      snapshot([
        said(1, 'before'),
        said(2, 'Compare flights'),
        reply(3, { text: 'Working on it' }),
        activity(4, 'goblin.thread_head', moved, { omits: [2, 3] }),
        said(5, 'after'),
      ]),
    )
    expect(parts.map((part) => [part.kind, part.id])).toEqual([
      ['user', '1:0'],
      ['thread-head', '4:0'],
      ['user', '5:0'],
    ])
  })
})
