// What an App hands the host for the owner and the agent: links to open, and context to share with the next
// message. Both come from the App, so both are untrusted: links open only on the owner's click, context travels as
// a labelled block the agent treats as data. A sent message is read back here too, with the files it carried.
import {
  Attachment,
  ComposerMetadata,
  type ComposerOption,
  McpOutcome,
  OwnTurnMark,
  ReceivedBlock,
  authorOf,
  memberOf,
} from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { isString, record, records } from './values.ts'

const MAX_CONTEXT = 8192

/** The text an App shared (`ui/update-model-context`): its text blocks, else its structured content as JSON. */
export function contextText(content: unknown, structured: unknown): string {
  const text = records(content)
    .filter((block) => block.type === 'text' && isString(block.text))
    .map((block) => String(block.text))
    .join('\n')
    .trim()
  const shared = text !== '' ? text : structured === undefined ? '' : JSON.stringify(structured)
  return shared.slice(0, MAX_CONTEXT)
}

/** A link an App may offer the owner: https only, no credentials in it; otherwise nothing. */
export function safeLink(url: string): URL | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' ? parsed : undefined
  } catch {
    // expected: an App's link that is not a URL is never offered
    return undefined
  }
}

/** What an App shared with a sent message, as the transcript keeps it: where it came from, and its text. */
export type SharedContext = { readonly from: string; readonly text: string }

const decodeAttachments = Schema.decodeUnknownOption(Schema.Struct({ attachments: Schema.Array(Attachment) }))
const decodeComposer = Schema.decodeUnknownOption(ComposerMetadata)
const decodeOutcome = Schema.decodeUnknownOption(McpOutcome)
const decodeOwn = Schema.decodeUnknownOption(OwnTurnMark)
const decodeReceived = Schema.decodeUnknownOption(ReceivedBlock)

/**
 * One block after the words: the files the owner attached (or goblin kept of what a message from elsewhere brought),
 * what an App shared, how a held call ended (an outcome from its connection), or goblin's mark of the owner's own turn
 * from elsewhere; anything else is none of them.
 */
function sharedBlock(
  block: string,
):
  | { readonly files: readonly Attachment[] }
  | { readonly app: SharedContext }
  | { readonly composer: ComposerMetadata['composer'] }
  | { readonly outcome: McpOutcome }
  | { readonly own: true }
  | undefined {
  let value: unknown
  try {
    value = JSON.parse(block)
  } catch {
    // expected: a block that is not JSON is the owner's own words, not files or shared context
    return undefined
  }
  const files = decodeAttachments(value)
  if (Option.isSome(files)) return { files: files.value.attachments }
  if (Option.isSome(decodeOwn(value))) return { own: true }
  const received = decodeReceived(value)
  if (Option.isSome(received)) return { files: received.value.received }
  const composer = decodeComposer(value)
  if (Option.isSome(composer)) return composer.value
  const outcome = decodeOutcome(value)
  if (Option.isSome(outcome)) return { outcome: outcome.value }
  const shared = record(value)
  const origin = record(shared?.origin)
  // An MCP App names its server; an agent app is its own name.
  const from = isString(origin?.connectionId) ? origin.connectionId : isString(origin?.app) ? origin.app : undefined
  return from !== undefined && origin?.trust === 'untrusted' && isString(shared?.appContext)
    ? { app: { from, text: shared.appContext } }
    : undefined
}

/**
 * A user message's parts as the runtime wrote them (`pi/content.ts`): an optional author tag block (a message from
 * a Source, an MCP client or a subagent), the words, then the attached files and App context blocks, and for
 * a message from elsewhere goblin's mark that it is the owner's own turn (`own`). Only blocks after the words count,
 * and only when every one of them is one of those, so nothing anyone typed is ever read as either.
 */
export function sharedContext(content: unknown): {
  readonly text: string
  readonly context: readonly SharedContext[]
  readonly attachments?: readonly Attachment[]
  readonly selections?: readonly ComposerOption[]
  readonly author?: string
  /** The member who wrote it, in a workspace of several people (ADR 0094): their messages are turns, not notes. */
  readonly member?: { readonly name: string; readonly userId: string }
  /** How a held call ended, when this is its outcome: only from an author, never the owner's own words. */
  readonly outcome?: McpOutcome
  /** The owner's own turn that came from elsewhere (a Source's, ADR 0066): only with an author, by goblin's mark. */
  readonly own?: true
} {
  if (isString(content)) return { text: content, context: [] }
  const blocks = records(content)
    .filter((block) => block.type === 'text' && isString(block.text))
    .map((block) => String(block.text))
  const tagged = blocks.length > 1 ? authorOf(blocks[0] ?? '') : undefined
  const [first, ...rest] = tagged === undefined ? blocks : blocks.slice(1)
  const shared = rest.map(sharedBlock)
  // A member's message is theirs as a typed one is the owner's; any other author names where it came from.
  const member = tagged === undefined ? undefined : memberOf(tagged)
  const author = member === undefined ? tagged : undefined
  const by = member !== undefined ? { member } : author === undefined ? {} : { author }
  if (!shared.every((block) => block !== undefined)) return { text: [first, ...rest].join('\n'), context: [], ...by }
  const { context, attachments, composer, outcome, own } = collected(shared)
  return {
    text: composer?.text ?? first ?? '',
    context,
    ...(composer === undefined ? {} : { selections: composer.selections }),
    ...(attachments.length > 0 && { attachments }),
    ...(member === undefined ? {} : { member }),
    ...(author === undefined ? {} : fromElsewhere(author, outcome, own)),
  }
}

/**
 * What a message from elsewhere carries besides its words: its author, how a held call ended, and goblin's mark of the
 * owner's own turn. Only an author's message carries the last two: the owner's own words never do.
 */
const fromElsewhere = (author: string, outcome: McpOutcome | undefined, own: boolean) => ({
  author,
  ...(outcome === undefined ? {} : { outcome }),
  ...(own ? { own: true as const } : {}),
})

/** The blocks after the words, sorted by what each one is. */
function collected(shared: readonly NonNullable<ReturnType<typeof sharedBlock>>[]) {
  return {
    context: shared.flatMap((block) => ('app' in block ? [block.app] : [])),
    attachments: shared.flatMap((block) => ('files' in block ? block.files : [])),
    composer: shared.flatMap((block) => ('composer' in block ? [block.composer] : [])).at(0),
    outcome: shared.flatMap((block) => ('outcome' in block ? [block.outcome] : [])).at(0),
    own: shared.some((block) => 'own' in block),
  }
}

/** The first line of shared context, short enough for a chip. */
export function contextPreview(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line.trim()
}
