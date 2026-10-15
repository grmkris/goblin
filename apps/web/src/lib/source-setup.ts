// A Source's setup in the owner's words (ADR 0066): the five facts a review shows before the owner confirms the exact
// revision, and a "Notify me via" copied from a confirmed Source's reply. Pure, so the review card and Settings only
// draw it.
import {
  ArgumentsTemplate,
  NotifySinkPolicy,
  SinkResultRules,
  type NotifySink,
  type SourceKeyValues,
  type SourceNewKeys,
  type SourceSetup,
  type SourceView,
  fillTemplate,
  templateProblem,
} from '@goblin/contracts'
import { Option, Schema } from 'effect'
import { filtersInWords } from './events.ts'

/** One fact of a review: what it is about, and what the setup says in words. */
export type Fact = { readonly term: string; readonly text: string }

/** What a review names besides the setup itself: its event's title and where new conversations go, in words. */
export type FactNames = { readonly event: string; readonly newKeys: (newKeys: SourceNewKeys) => string }

/** A pointer and the value it is compared with, in words: `/from/isOwner` is `true`. */
const matchWords = (match: { readonly pointer: string; readonly equals: unknown }): string =>
  `${match.pointer === '' ? 'the message' : match.pointer} is ${JSON.stringify(match.equals)}`

const resultWords = (reply: NonNullable<SourceSetup['reply']>): string => {
  if (reply.result === undefined) return 'structured results are not classified (unknown outcomes stay stopped)'
  const rules = [
    `accepted when ${matchWords(reply.result.accepted)}`,
    ...(reply.result.retryable === undefined ? [] : [`retryable when ${matchWords(reply.result.retryable)}`]),
    ...(reply.result.rejected === undefined ? [] : [`rejected when ${matchWords(reply.result.rejected)}`]),
  ]
  return `results: ${rules.join('; ')}${reply.result.retryAt === undefined ? '' : `; retry no earlier than ${reply.result.retryAt}`}`
}

/** How a setup reads its messages, in words. */
function readWords(read: SourceSetup['read']): string {
  const parts = [
    `its words at ${read.text}`,
    ...(read.title === undefined ? [] : [`its conversation's name at ${read.title}`]),
    ...(read.attachments === undefined ? [] : [`what it brought at ${read.attachments}, kept in your files`]),
  ].join(', ')
  const incoming = read.direction === undefined ? '' : `, only those where ${matchWords(read.direction)}`
  if (read.from === 'payload') {
    const each = read.items === undefined ? 'the event is one message' : `each message at ${read.items}`
    return `From the event's data: ${each}, ${parts}${incoming}`
  }
  return `By calling ${read.tool} from where it left off (cursor at ${read.cursor}): each message at ${read.items}, ${parts}${incoming}`
}

/**
 * The five facts of a setup and what becomes of a new conversation, in the order a review shows them. Every pointer
 * and tool name is shown as it is, so the owner confirms exactly what goblin will do.
 */
export function setupFacts(setup: SourceSetup, names: FactNames): readonly Fact[] {
  const filters = Object.keys(setup.wake.arguments).length === 0 ? '' : ` (${filtersInWords(setup.wake.arguments)})`
  const { reply } = setup
  return [
    { term: 'Wakes on', text: `“${names.event}”${filters}` },
    {
      term: 'Conversations',
      text: `Told apart by ${setup.key.map((part) => `${part.name} (${part.pointer})`).join(' and ')}`,
    },
    {
      term: 'You speak',
      text:
        'all' in setup.speaksForMe
          ? 'In every message: each one becomes your own turn'
          : `When ${matchWords(setup.speaksForMe)}: those become your own turns`,
    },
    {
      term: 'Others',
      text:
        setup.others === 'notice'
          ? 'Shown to you as notices, never as your words'
          : 'Dropped: goblin keeps nothing of them',
    },
    { term: 'Reads', text: readWords(setup.read) },
    {
      term: 'Answers',
      text:
        reply === undefined
          ? 'Not sent back'
          : `Sent back with ${reply.tool}, in pieces of at most ${reply.maxChars.toLocaleString()} characters; ${resultWords(reply)}`,
    },
    { term: 'New conversations', text: names.newKeys(setup.newKeys) },
  ]
}

/** A conversation's key values as the placeholders a reply names them by: `{ 'key.chat': 'dm' }`. */
export const keyPlaceholders = (values: SourceKeyValues): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [`key.${name}`, value]))

/** What "Notify me via" sends a notice with: a connection's tool and its arguments with `{{text}}` in them. */
export type SinkDraft = NotifySink

const decodeArguments = Schema.decodeUnknownOption(ArgumentsTemplate)

/**
 * The arguments the owner wrote for "Notify me via", as JSON text: the template, or why it is not one (not JSON, not
 * an object, or a placeholder `allowed` refuses, or no `{{text}}`).
 */
export function sinkArguments(
  text: string,
  allowed: (placeholder: string) => boolean,
): { readonly template: ArgumentsTemplate } | { readonly problem: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // expected: text that is not JSON is said so, and nothing is saved
    return { problem: 'The arguments are not JSON.' }
  }
  return Option.match(decodeArguments(parsed), {
    onNone: () => ({ problem: 'The arguments must be a JSON object.' }),
    onSome: (template) => {
      const problem = templateProblem(template, allowed, ['text'])
      return problem === undefined ? { template } : { problem }
    },
  })
}

/**
 * A "Notify me via" copied from a confirmed Source's reply: its tool, and its arguments with the conversation's key
 * (`values`) filled in, `{{text}}` and `{{operationId}}` left for each notice. None for a Source that sends nothing back.
 */
export function sinkFromSource(source: SourceView, values: SourceKeyValues): SinkDraft | undefined {
  const { reply } = source.setup
  if (reply === undefined) return undefined
  const filled = decodeArguments(fillTemplate(reply.arguments, keyPlaceholders(values)))
  return Option.match(filled, {
    onNone: () => undefined,
    onSome: (args) => ({
      connectionId: source.connectionId,
      tool: reply.tool,
      arguments: args,
      ...(reply.result === undefined ? {} : { result: reply.result }),
      echo: source.setup.wake,
    }),
  })
}

/** Delivery and echo rules, as reviewed by the owner in Settings. */
export const sinkPolicy = (text: string): NotifySinkPolicy | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(NotifySinkPolicy))(text))

/** Reviewed reply-result rules, or null to remove them; invalid JSON cannot be saved. */
export const replyResultRules = (text: string): SinkResultRules | null | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.NullOr(SinkResultRules)))(text))
