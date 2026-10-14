import type { Message, ViewState } from './types'

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid companion response')
  // SAFETY: non-null non-array JSON objects have string keys; values stay unknown until checked below.
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid companion text')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid companion flag')
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid companion list')
  return value
}
function message(value: unknown): Message {
  const item = object(value)
  const role = item.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') throw new Error('Invalid message role')
  return {
    id: text(item.id),
    text: text(item.text),
    role,
    ...(item.label === undefined ? {} : { label: text(item.label) }),
  }
}
export function decodeView(value: unknown): ViewState {
  const v = object(value)
  if (v.mode !== 'fixture' && v.mode !== 'live') throw new Error('Invalid companion mode')
  if (typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision)) throw new Error('Invalid view revision')
  return {
    revision: v.revision,
    mode: v.mode,
    selected: text(v.selected),
    title: text(v.title),
    status: text(v.status),
    streaming: boolean(v.streaming),
    history: boolean(v.history),
    signedIn: boolean(v.signedIn),
    messages: array(v.messages).map(message),
    chats: array(v.chats).map((item) => {
      const chat = object(item)
      return { id: text(chat.id), title: text(chat.title), detail: text(chat.detail) }
    }),
    ...(v.pendingOperation === undefined ? {} : { pendingOperation: text(v.pendingOperation) }),
  }
}
