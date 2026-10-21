import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { conversationId, entryId } from '../src/pi/context.ts'
import { askedQuestions, entryViews } from '../src/pi/entry-view.ts'

const questions = () => [
  {
    id: 'size',
    prompt: 'Which size?',
    kind: 'single',
    options: [
      { id: 'square', label: 'Square', description: '3000 × 3000' },
      { id: 'tall', label: 'Tall' },
    ],
  },
  { id: 'tone', prompt: 'Any tone to keep?', kind: 'text' },
]

/** A Pi entry numbered `id` of `kind`, in one chat. */
const entry = (id: number, kind: string, fields: Pick<EntryRecord, 'model' | 'data'>): EntryRecord => ({
  id: entryId(id),
  conversationId: conversationId('9'),
  kind,
  ...fields,
})

/** What `ask_user` returned in a Persona's fork: its result, which ends the fork's run (ADR 0082). */
const asked = entry(3, 'pi.toolResult', {
  model: [
    {
      role: 'toolResult',
      toolName: 'ask_user',
      toolCallId: 'call-3',
      content: [],
      isError: false,
      details: { kind: 'question', questions: questions() },
      timestamp: 3,
    },
  ],
})

/** A Persona's answer written back into the chat it was tagged in, holding what it asked. */
const answer = (withQuestions: boolean) =>
  entry(7, 'app.persona', {
    data: {
      persona: 4,
      name: 'Squarewave',
      revision: 2,
      avatar: { glyph: 'S', hue: 210 },
      operationId: 'op-7',
      text: 'Two things before I plan it.',
      ...(withQuestions ? { questions: questions() } : {}),
    },
    model: [{ role: 'user', content: 'Two things before I plan it.', timestamp: 7 }],
  })

describe('what a server reads of a Persona that asks (ADR 0082)', () => {
  it("reads the questions from ask_user's result, and none from anything else", () => {
    expect(askedQuestions(asked)).toEqual(questions())
    expect(askedQuestions(answer(true))).toBeUndefined()
  })

  it("carries a Persona's questions on its answer, and leaves them out when it asked nothing", () => {
    expect(entryViews(answer(true))).toEqual([
      {
        kind: 'persona',
        id: 7,
        persona: { id: 4, name: 'Squarewave', revision: 2 },
        operationId: 'op-7',
        text: 'Two things before I plan it.',
        questions: questions(),
      },
    ])
    expect(entryViews(answer(false))[0]).not.toHaveProperty('questions')
  })
})

/** A message to Scout and Owl (`app.persona_ask`), entry 7, with `content` as the model reads it. */
const tag = (content: unknown) =>
  entry(7, 'app.persona_ask', {
    data: {
      personas: [
        { id: 4, name: 'Scout', revision: 2 },
        { id: 5, name: 'Owl', revision: 1 },
      ],
      order: 'parallel',
    },
    // SAFETY: Pi stores the owner's user message as the model reads it; the views read only its role and content.
    model: [{ role: 'user', content, timestamp: 1 }] as NonNullable<EntryRecord['model']>,
  })

describe('what a server reads of a message to Personas (ADR 0090)', () => {
  it("is the owner's message without the [to …] the model reads, saying whom it went to", () => {
    expect(entryViews(tag('[to @Scout, @Owl] find the venue'))).toEqual([
      {
        kind: 'message',
        id: 7,
        role: 'owner',
        text: 'find the venue',
        to: [
          { id: 4, name: 'Scout' },
          { id: 5, name: 'Owl' },
        ],
        final: true,
      },
    ])
  })

  it('keeps the author a message from elsewhere names first', () => {
    const authored = [
      { type: 'text', text: '[from Swarmm]' },
      { type: 'text', text: '[to @Scout, @Owl] find the venue' },
    ]
    expect(entryViews(tag(authored))).toMatchObject([{ author: 'Swarmm', text: 'find the venue' }])
  })
})
