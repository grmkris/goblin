import type { EntryRecord } from '@earendil-works/pi-durable'
import { type ConversationEntryView, PersonaAnswerData, QuestionSpec, authorOf } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { textBlocks } from './transcript.ts'

/**
 * Pi entries as a server reads them (ADR 0081): the owner's and the agent's words, Persona answers and `ask_user`
 * questions, each with its entry's id. Tool traffic, bookkeeping and messages without text are left out.
 */

const decodeAnswer = Schema.decodeUnknownOption(PersonaAnswerData)
const decodeAsk = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('question'), questions: Schema.Array(QuestionSpec) }),
)

/** A Persona's attributed answer entry, and what it stopped on. */
const personaView = (id: number, data: unknown): readonly ConversationEntryView[] =>
  Option.match(decodeAnswer(data), {
    onNone: () => [],
    onSome: (answer) => [
      {
        kind: 'persona',
        id,
        persona: { id: answer.persona, name: answer.name, revision: answer.revision },
        operationId: answer.operationId,
        text: answer.text,
        ...(answer.hold === undefined ? {} : { hold: { kind: answer.hold.kind, name: answer.hold.name } }),
        ...(answer.questions === undefined ? {} : { questions: answer.questions }),
      },
    ],
  })

/** What `ask_user` asked in `entry`, when it is the tool's result; a Persona's answer ends on it (ADR 0082). */
export const askedQuestions = (entry: Pick<EntryRecord, 'model'>): readonly QuestionSpec[] | undefined => {
  for (const message of entry.model ?? [])
    if (message.role === 'toolResult' && message.toolName === 'ask_user') {
      const asked = Option.getOrUndefined(decodeAsk(message.details))
      if (asked !== undefined) return asked.questions
    }
  return undefined
}

/** The owner's words, without the author tag a message from someone else carries first. */
const ownerView = (id: number, content: unknown): readonly ConversationEntryView[] => {
  const blocks = textBlocks(content)
  const author = blocks.length > 1 ? authorOf(blocks[0] ?? '') : undefined
  const text = (author === undefined ? blocks : blocks.slice(1)).join('\n')
  if (text === '') return []
  return [{ kind: 'message', id, role: 'owner', text, ...(author === undefined ? {} : { author }), final: true }]
}

/** One Pi entry as the views a server reads, oldest first within it. */
export const entryViews = (entry: EntryRecord): readonly ConversationEntryView[] => {
  const id = Number(entry.id)
  if (entry.kind === 'app.persona') return personaView(id, entry.data)
  return (entry.model ?? []).flatMap((message): readonly ConversationEntryView[] => {
    if (message.role === 'toolResult')
      return message.toolName === 'ask_user'
        ? Option.match(decodeAsk(message.details), {
            onNone: () => [],
            onSome: (asked) => [{ kind: 'question', id, questions: asked.questions }],
          })
        : []
    if (message.role === 'user') return entry.kind === 'pi.user' ? ownerView(id, message.content) : []
    if (message.role !== 'assistant' || entry.kind !== 'pi.assistant') return []
    const text = textBlocks(message.content).join('\n')
    return text === '' ? [] : [{ kind: 'message', id, role: 'agent', text, final: message.stopReason !== 'toolUse' }]
  })
}
