import type { UserMessage } from '@earendil-works/pi-ai'
import {
  Attachment,
  ComposerMetadata,
  type GoblinMetadata,
  McpOutcome,
  OwnTurnMark,
  ReceivedBlock,
  authorOf,
  memberOf,
} from '@goblin/contracts'
import { Predicate } from 'effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { QueuedParts } from './state.ts'

// A user message as a chat's stream carries it: the words alone, and what the runtime wrote around them
// (`pi/content.ts`) as `metadata.goblin`. This is the server's reading of what the web read for itself before.

/** What an open App shared (`pi/content.ts` `ownerContent`): where it came from, labelled untrusted, and its text. */
const AppShared = Schema.Struct({
  origin: Schema.Union([
    Schema.Struct({ connectionId: Schema.String, trust: Schema.Literal('untrusted') }),
    Schema.Struct({ app: Schema.String, trust: Schema.Literal('untrusted') }),
  ]),
  appContext: Schema.String,
})

/** One JSON block after the words: each shape the runtime writes there, and nothing else. */
const Added = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ attachments: Schema.Array(Attachment) }),
    OwnTurnMark,
    ReceivedBlock,
    ComposerMetadata,
    McpOutcome,
    AppShared,
  ]),
)
type Added = typeof Added.Type
const decodeAdded = Schema.decodeUnknownOption(Added)

/** The words of a user message and its marks. */
export type UserParts = { readonly text: string; readonly mark: GoblinMetadata }

/** The marks the blocks after the words make, each only when it has one. */
function addedMarks(added: readonly Added[]): GoblinMetadata {
  const files = added.flatMap((block) =>
    'attachments' in block ? block.attachments : 'received' in block ? block.received : [],
  )
  const context = added.flatMap((block) =>
    'appContext' in block
      ? [
          {
            from: 'connectionId' in block.origin ? block.origin.connectionId : block.origin.app,
            text: block.appContext,
          },
        ]
      : [],
  )
  const composer = added.flatMap((block) => ('composer' in block ? [block.composer] : [])).at(0)
  return {
    ...(files.length === 0 ? {} : { attachments: files }),
    ...(context.length === 0 ? {} : { context }),
    ...(composer === undefined ? {} : { selections: composer.selections }),
  }
}

/**
 * Who wrote it, from its author tag: a member's message is theirs (`member`); any other author names where it came
 * from, and only such a message carries how a held call ended (`outcome`) or the mark of the owner's own turn (`own`).
 */
function authorMarks(tag: string | undefined, added: readonly Added[]): GoblinMetadata {
  if (tag === undefined) return {}
  const member = memberOf(tag)
  if (member !== undefined) return { member }
  const outcome = added.flatMap((block) => ('continuation' in block ? [block] : [])).at(0)
  return {
    author: tag,
    ...(outcome === undefined ? {} : { outcome }),
    ...(added.some((block) => 'ownTurn' in block) ? { own: true } : {}),
  }
}

/**
 * A user message's words and marks: an optional author tag block first, then the words, then blocks the runtime
 * added. The added blocks count only when every one of them is one of its shapes, so nothing anyone typed is read as
 * one. With composer choices the words are the composer's own text, without the `@`/`/` prefixes the model reads.
 */
export function userParts(content: UserMessage['content']): UserParts {
  if (typeof content === 'string') return { text: content, mark: {} }
  const blocks = content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  const tag = blocks.length > 1 ? authorOf(blocks[0] ?? '') : undefined
  const [first = '', ...rest] = tag === undefined ? blocks : blocks.slice(1)
  const decoded = rest.map((block) => decodeAdded(block))
  if (!decoded.every(Option.isSome)) return { text: [first, ...rest].join('\n'), mark: authorMarks(tag, []) }
  const added = decoded.map((block) => block.value)
  const composer = added.flatMap((block) => ('composer' in block ? [block.composer.text] : [])).at(0)
  return { text: composer ?? first, mark: { ...addedMarks(added), ...authorMarks(tag, added) } }
}

/** What a queued input says (`InboxDoc`'s JSON content), as a user message would carry it. */
export function queuedParts(content: unknown): QueuedParts {
  const blocks = Array.isArray(content)
    ? content.flatMap((block: unknown) =>
        Predicate.isReadonlyObject(block) && block.type === 'text' && Predicate.isString(block.text)
          ? [{ type: 'text' as const, text: block.text }]
          : [],
      )
    : undefined
  const { text, mark } = userParts(Predicate.isString(content) ? content : (blocks ?? []))
  return {
    text,
    ...(mark.author === undefined ? {} : { author: mark.author }),
    ...(mark.attachments === undefined ? {} : { attachments: mark.attachments }),
    ...(mark.selections === undefined ? {} : { selections: mark.selections }),
    ...(mark.context === undefined ? {} : { context: mark.context }),
  }
}
