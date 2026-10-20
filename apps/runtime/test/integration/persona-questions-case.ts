import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { type PersonaDefinition, PersonaAnswerData } from '@goblin/contracts'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { lever, person, signedIn, type Person } from './owner-requests.ts'
import { ownerSnapshot } from './probe-reads.ts'
import { until as untilWithin } from './until.ts'

const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({
    entries: Schema.optional(
      Schema.Array(Schema.Struct({ id: Schema.Number, kind: Schema.String, data: Schema.optional(Schema.Unknown) })),
    ),
  }),
)
const decodeAnswer = Schema.decodeUnknownSync(PersonaAnswerData)
const decodeSeen = Schema.decodeUnknownSync(
  Schema.Struct({
    requests: Schema.Array(
      Schema.Struct({
        messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
        context: Schema.optional(Schema.String),
      }),
    ),
  }),
)

/** As `until`, for up to 20 s: a Persona answers after its fork's turn. */
const until = <A>(read: () => Promise<A>, done: (value: A) => boolean) => untilWithin(read, done, 20_000)

/** The Persona answers in `chat` so far, oldest first, with the entry each is. */
const answers = async (me: AgentFetch, chat: string) =>
  (decodeEntries(await ownerSnapshot(me, chat)).entries ?? [])
    .filter((entry) => entry.kind === 'app.persona')
    .map((entry) => ({ entry: entry.id, ...decodeAnswer(entry.data) }))

/** Until `chat` holds `count` answers. */
const answered = (me: AgentFetch, chat: string, count: number) =>
  until(
    () => answers(me, chat),
    (found) => found.length >= count,
  )

const persona: PersonaDefinition = {
  name: 'Asker',
  avatar: { glyph: 'A', hue: 200 },
  role: 'Plans covers',
  instructions: 'Ask before you plan.',
  setup: { mcpServers: [], skills: [], apps: [] },
}

const QUESTIONS = [
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

/** The owner's message into `chat`, tagging `personaId`. */
const tag = (me: AgentFetch, chat: string, personaId: number, input: string) =>
  callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: chat },
      payload: { input, operationId: crypto.randomUUID(), selections: [{ kind: 'persona', personaId }] },
    }),
  )

/** A thread started from `chat` at `anchor`, its first message tagging `personaId`. */
const thread = (me: AgentFetch, chat: string, anchor: 'empty' | 'latest', personaId: number, input: string) =>
  callOwner(me, (api) =>
    api.conversations.startThread({
      params: { id: chat },
      payload: {
        operationId: crypto.randomUUID(),
        anchor,
        message: { input, selections: [{ kind: 'persona', personaId }] },
      },
    }),
  )

/** A tagged Persona asks with ask_user: its answer holds the questions, and the owner's next tag answers them. */
async function asksAndIsAnswered(url: string, owner: Person, me: AgentFetch, asker: number) {
  await tag(me, '1', asker, `persona-call ask_user ${JSON.stringify({ questions: QUESTIONS })}`)
  const [asked] = await answered(me, '1', 1)
  expect(asked).toMatchObject({ persona: asker, name: 'Asker', questions: QUESTIONS })
  const read = await callOwner(me, (api) => api.conversations.entries({ params: { id: '1' }, query: { after: 0 } }))
  expect(read.entries).toContainEqual(expect.objectContaining({ kind: 'persona', questions: QUESTIONS }))
  expect(read.invocations).toContainEqual(expect.objectContaining({ persona: asker, state: 'answered' }))

  await tag(me, '1', asker, 'Answers:\n- Which size? Square\n- Any tone to keep? Warm')
  const after = await answered(me, '1', 2)
  expect(after.at(-1)?.questions).toBeUndefined()
  // The next fork reads both what the Persona asked and the owner's answers.
  const requests = decodeSeen(await (await lever(url, owner, 'queue/seen')).json()).requests
  const fork = requests.findLast((request) => request.context?.includes('<persona>') === true)
  const text = fork?.messages.map((message) => message.text).join('\n') ?? ''
  expect(text).toContain('Asked:\n1. Which size?')
  expect(text).toContain('Which size? Square')
}

/**
 * A Persona's own thread, then a sub-thread started from it at its newest settled entry ('latest'), where the same
 * Persona answers again: what a service's job thread is, branched from the conversation that agreed it.
 */
async function threadFromThread(me: AgentFetch, asker: number) {
  const started = await thread(me, '1', 'empty', asker, 'Plan a cover for Night Shift.')
  const parent = started.thread.id
  const [planned] = await answered(me, parent, 1)
  expect(planned).toMatchObject({ persona: asker })
  const job = await thread(me, parent, 'latest', asker, 'Accepted. Do the work now.')
  expect(job.thread.id).not.toBe(parent)
  // Forked at the parent's newest settled entry, the Persona's answer there, which the thread inherits by reference.
  expect(job.thread.forkEntry).toBe(planned?.entry)
  const seen = await answered(me, job.thread.id, 2)
  expect(seen[0]?.entry).toBe(planned?.entry)
  const worked = seen.at(-1)
  expect(worked).toMatchObject({ persona: asker })
  // Read after the entry it forked at, the thread holds only its own entries.
  const own = await callOwner(me, (api) =>
    api.conversations.entries({ params: { id: job.thread.id }, query: { after: job.thread.forkEntry ?? 0 } }),
  )
  expect(own.entries.filter((entry) => entry.kind === 'persona').map((entry) => entry.id)).toEqual([worked?.entry])
}

/** ADR 0082 in local workerd: a tagged Persona asks with ask_user and is answered by a tag; Persona threads branch. */
export async function personaQuestionsCase(url: string): Promise<void> {
  const owner = await person(url)
  const me = signedIn(url, owner)
  const made = await callOwner(me, (api) =>
    api.personas.create({ payload: { ...persona, operationId: crypto.randomUUID() } }),
  )
  await asksAndIsAnswered(url, owner, me, made.id)
  await threadFromThread(me, made.id)
}
