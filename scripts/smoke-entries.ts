/**
 * Reading a chat in smoke checks as its stream maps it (AG-UI messages, docs/architecture/streams.md): whether a
 * Delegate reported, and whether the chat is idle by its stream's events.
 */
import { Schema } from 'effect'

const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof ObjectSchema.Type
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))
const isObject = Schema.is(ObjectSchema)

/** `metadata.goblin` of a message or event, or none. */
export function marksOf(wire: JsonObject): JsonObject {
  const metadata = wire['metadata']
  const goblin = isObject(metadata) ? metadata['goblin'] : undefined
  return isObject(goblin) ? goblin : {}
}

/** The words of a message, whether a string or text parts. */
const words = (message: JsonObject): string => {
  const content = message['content']
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? objects(content)
        .flatMap((part) => (typeof part['text'] === 'string' ? [part['text']] : []))
        .join(' ')
    : ''
}

/**
 * Whether the Delegate `name` reported among `messages`: its result posted passively (`goblin.delegate_result`), which
 * Goblin does not answer again (ADR 0033), or, when the spawn asked for synthesis, its report as an input (authored
 * `subagent <name>`) that an answer follows.
 */
export function delegateReported(messages: readonly JsonObject[], name: string): boolean {
  const passive = messages.some((message) => {
    const content = message['content']
    if (message['activityType'] !== 'goblin.delegate_result' || !isObject(content)) return false
    return content['name'] === name && typeof content['text'] === 'string' && content['text'].trim() !== ''
  })
  const report = messages.findIndex(
    (message) => message['role'] === 'user' && marksOf(message)['author'] === `subagent ${name}`,
  )
  const answered =
    report >= 0 &&
    messages.slice(report + 1).some((message) => message['role'] === 'assistant' && words(message).trim() !== '')
  return passive || answered
}

/** The queue's length after `event`, or `queued` when it does not change it. */
function queuedAfter(event: JsonObject, queued: number): number {
  const snapshot = event['snapshot']
  if (event['type'] === 'STATE_SNAPSHOT' && isObject(snapshot)) return objects(snapshot['queue'] ?? []).length
  if (event['type'] !== 'STATE_DELTA') return queued
  const change = objects(event['delta'] ?? []).findLast((op) => op['path'] === '/queue')
  return change === undefined ? queued : objects(change['value'] ?? []).length
}

/** Whether `events`, a stream's epoch from its start, leave the chat idle: no run open and nothing queued. */
export function idleAfter(events: readonly JsonObject[]): boolean {
  let running = false
  let queued = 0
  for (const event of events) {
    if (event['type'] === 'RUN_STARTED') running = true
    else if (event['type'] === 'RUN_FINISHED' || event['type'] === 'RUN_ERROR') running = false
    queued = queuedAfter(event, queued)
  }
  return !running && queued === 0
}
