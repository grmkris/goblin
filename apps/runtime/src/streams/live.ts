import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { MessageChange } from '@earendil-works/pi-durable'
import { type AguiEvent, EventType, type GoblinMetadata } from '@goblin/contracts'
import { assistantId, goblin, reasoningId, reasoningSpanId, stopOf } from './messages.ts'
import { tokenCounts } from './state.ts'

// The assistant message in flight, followed block by block: its text as TEXT_MESSAGE_CONTENT, each visible thinking
// block as a reasoning message in a span of its own, each tool call opened when it starts and given its arguments,
// whole, once they are complete (Pi's argument deltas are paths into a JSON object, not JSON text). What has been sent
// is counted per block, so a snapshot after an overflow sends only the rest.

type Block = AssistantMessage['content'][number]

/** What the stream sent of one content block. */
export type BlockSent =
  | { readonly kind: 'text' | 'thinking'; sent: number; readonly hidden?: true }
  | { readonly kind: 'toolCall'; readonly id: string; readonly name: string }

/** The assistant message in flight: its id, when its request started, and what each block sent. */
export type MessageSent = {
  readonly id: string
  readonly at: number
  /** `TEXT_MESSAGE_START` was sent: at its first text or tool call, so thinking before it does not overlap it. */
  opened: boolean
  /** Text blocks begun: each after the first starts on a new line, as the transcript joins them. */
  texts: number
  /** The thinking block whose reasoning message is open. */
  thinking?: number | undefined
  readonly blocks: (BlockSent | null)[]
}

/** A message begins: nothing sent yet. */
export const beginMessage = (chat: string, at: number): MessageSent => ({
  id: assistantId(chat, at),
  at,
  opened: false,
  texts: 0,
  blocks: [],
})

function open(message: MessageSent, out: AguiEvent[]): void {
  if (message.opened) return
  message.opened = true
  out.push({
    type: EventType.TEXT_MESSAGE_START,
    messageId: message.id,
    role: 'assistant',
    ...goblin({ at: message.at }),
  })
}

/** The open reasoning message closes, with its span: a later block began, or the message ended. */
function closeThinking(message: MessageSent, out: AguiEvent[]): void {
  const index = message.thinking
  if (index === undefined) return
  message.thinking = undefined
  if (message.blocks[index]?.kind === 'thinking' && message.blocks[index].hidden === true) return
  out.push(
    { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId(message.id, index) },
    { type: EventType.REASONING_END, messageId: reasoningSpanId(message.id, index) },
  )
}

/** Block `index` begins as `block` says; redacted thinking is never shown, so it opens nothing. */
function begin(message: MessageSent, out: AguiEvent[], index: number, block: Block): BlockSent {
  closeThinking(message, out)
  if (block.type === 'toolCall') {
    open(message, out)
    out.push({
      type: EventType.TOOL_CALL_START,
      toolCallId: block.id,
      toolCallName: block.name,
      parentMessageId: message.id,
    })
    return (message.blocks[index] = { kind: 'toolCall', id: block.id, name: block.name })
  }
  if (block.type === 'text') {
    open(message, out)
    if (message.texts > 0) out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: '\n' })
    message.texts += 1
    return (message.blocks[index] = { kind: 'text', sent: 0 })
  }
  message.thinking = index
  if (block.redacted === true) return (message.blocks[index] = { kind: 'thinking', sent: 0, hidden: true })
  out.push(
    { type: EventType.REASONING_START, messageId: reasoningSpanId(message.id, index) },
    {
      type: EventType.REASONING_MESSAGE_START,
      messageId: reasoningId(message.id, index),
      role: 'reasoning',
      ...goblin({ at: message.at }),
    },
  )
  return (message.blocks[index] = { kind: 'thinking', sent: 0 })
}

/** Text appended to block `index`, as the content of its message. */
function append(message: MessageSent, out: AguiEvent[], index: number, sent: BlockSent, delta: string): void {
  if (sent.kind === 'toolCall' || delta === '') return
  sent.sent += delta.length
  if (sent.kind === 'text') out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta })
  else if (sent.hidden !== true)
    out.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId(message.id, index), delta })
}

/** Block `index` as it is now: begun if new, and whatever of its text was not sent yet. */
export function syncBlock(message: MessageSent, out: AguiEvent[], index: number, block: Block): void {
  const sent = message.blocks[index] ?? begin(message, out, index, block)
  if (sent.kind === 'toolCall') return
  const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : ''
  append(message, out, index, sent, text.slice(sent.sent))
}

/** One of Pi's changes to the message in flight. */
export function applyChange(message: MessageSent, out: AguiEvent[], change: MessageChange): void {
  switch (change.type) {
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
    case 'block':
      syncBlock(message, out, change.contentIndex, change.block)
      return
    case 'text_delta':
    case 'thinking_delta': {
      const empty: Block =
        change.type === 'text_delta' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' }
      const sent = message.blocks[change.contentIndex] ?? begin(message, out, change.contentIndex, empty)
      append(message, out, change.contentIndex, sent, change.delta)
      return
    }
    case 'toolcall_delta':
      // The arguments are sent whole when the message ends.
      return
    case 'message':
      for (const [index, block] of change.message.content.entries()) syncBlock(message, out, index, block)
  }
}

/**
 * The message ends: the rest of each block as `final` has it, the message closed with its entry and why it stopped,
 * then each tool call's arguments, whole, and its end. Without `final` (a partial that vanished, a run that ended) it
 * closes with what was sent, and its tool calls end without arguments.
 */
export function endMessage(
  message: MessageSent,
  out: AguiEvent[],
  final?: { readonly message: AssistantMessage; readonly entryId: number; readonly marks: GoblinMetadata },
): void {
  for (const [index, block] of (final?.message.content ?? []).entries()) syncBlock(message, out, index, block)
  closeThinking(message, out)
  open(message, out)
  const stop = final === undefined ? undefined : stopOf(final.message)
  const mark =
    final === undefined
      ? {}
      : {
          entryId: final.entryId,
          ...(stop === undefined ? {} : { stop }),
          usage: tokenCounts(final.message.usage),
          ...final.marks,
        }
  out.push({ type: EventType.TEXT_MESSAGE_END, messageId: message.id, ...goblin(mark) })
  for (const [index, sent] of message.blocks.entries()) {
    if (sent?.kind !== 'toolCall') continue
    const block = final?.message.content[index]
    if (block?.type === 'toolCall')
      out.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: sent.id, delta: JSON.stringify(block.arguments) })
    out.push({ type: EventType.TOOL_CALL_END, toolCallId: sent.id })
  }
}
