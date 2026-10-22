// What every translated stream must be, whatever the case: valid AG-UI 1.0 events (by `@ag-ui/core`'s own schemas),
// goblin's parts valid by their contracts, and a well-formed sequence (every message, call, span, step and run that
// opens closes once, in order).
import { EventSchema } from '@ag-ui/core/schemas'
import {
  type AguiEvent,
  CustomName,
  EventType,
  GoblinActivity,
  GoblinMetadataOf,
  GoblinState,
  StreamMoved,
  type StreamTier,
  ToolProgress,
} from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { type StreamCursor, translate } from '../../src/streams/agui.ts'
import type { Recording } from './scenarios.ts'

/** A STATE patch's operations, each on a member of the document and, when it replaces one, valid as that member. */
function statePatch(delta: Extract<AguiEvent, { type: EventType.STATE_DELTA }>['delta']): void {
  const members: readonly string[] = Object.keys(GoblinState.fields)
  for (const op of delta) {
    const key = members.find((member) => op.path === `/${member}`)
    expect(key, `${op.path} is no member of the STATE document`).toBeDefined()
    // SAFETY: `key` was found among the document's own members just above.
    const member = GoblinState.fields[key as keyof GoblinState]
    if (op.op === 'replace') Schema.decodeUnknownSync(member)(op.value)
  }
}

/** The STATE document a tier carries: all of it, or `/attention` alone. */
const STATE_OF = {
  full: GoblinState,
  answers: Schema.Struct({ attention: GoblinState.fields.attention }).check(Schema.isMaxProperties(1)),
} as const

/** goblin's own part of `event`, decoded by its contract (a failure throws with the path). */
function goblinParts(event: AguiEvent, tier: StreamTier): void {
  if (event.metadata !== undefined) Schema.decodeUnknownSync(GoblinMetadataOf)(event.metadata)
  if (event.type === EventType.STATE_SNAPSHOT) Schema.decodeUnknownSync(STATE_OF[tier])(event.snapshot)
  if (event.type === EventType.STATE_DELTA) statePatch(event.delta)
  if (event.type === EventType.ACTIVITY_SNAPSHOT)
    Schema.decodeUnknownSync(GoblinActivity)({ activityType: event.activityType, content: event.content })
  if (event.type === EventType.CUSTOM)
    Schema.decodeUnknownSync(event.name === CustomName.toolProgress ? ToolProgress : StreamMoved)(event.value)
  if (event.type !== EventType.MESSAGES_SNAPSHOT) return
  for (const message of event.messages) Schema.decodeUnknownSync(Schema.UndefinedOr(GoblinMetadataOf))(message.metadata)
}

/** Opens and closes by key: what is open now, and the order of every close. */
class Ledger {
  readonly #open = new Set<string>()
  opens(key: string): void {
    expect(this.#open.has(key), `${key} opened twice`).toBe(false)
    this.#open.add(key)
  }
  within(key: string): void {
    expect(this.#open.has(key), `${key} is not open`).toBe(true)
  }
  closes(key: string): void {
    this.within(key)
    this.#open.delete(key)
  }
  open(prefix: string): string[] {
    return [...this.#open].filter((key) => key.startsWith(prefix))
  }
}

type Rule = (ledger: Ledger, event: AguiEvent, args: Map<string, number>) => void

/** The key a message, span or call event is about. */
const about = (event: AguiEvent): string =>
  'toolCallId' in event ? `call:${event.toolCallId}` : 'messageId' in event ? event.messageId : ''

/** A run ends with nothing of it left open. */
const runEnds: Rule = (ledger) => {
  expect(ledger.open('message:'), 'messages left open at the run end').toEqual([])
  expect(ledger.open('call:'), 'tool calls left open at the run end').toEqual([])
  expect(ledger.open('step'), 'a step left open at the run end').toEqual([])
  ledger.closes('run')
}

/** A call's arguments arrive once, as JSON, while it is open. */
const callArgs: Rule = (ledger, event, args) => {
  if (event.type !== EventType.TOOL_CALL_ARGS) return
  args.set(event.toolCallId, (args.get(event.toolCallId) ?? 0) + 1)
  expect(args.get(event.toolCallId), `${event.toolCallId}'s arguments sent twice`).toBe(1)
  expect(() => JSON.parse(event.delta)).not.toThrow()
  ledger.within(about(event))
}

/** The sequence rules, by event type: what each opens, needs open, or closes. */
const RULES: Partial<Record<EventType, Rule>> = {
  [EventType.RUN_STARTED]: (ledger) => ledger.opens('run'),
  [EventType.RUN_FINISHED]: runEnds,
  [EventType.RUN_ERROR]: runEnds,
  [EventType.STEP_STARTED]: (ledger) => {
    ledger.within('run')
    ledger.opens('step')
  },
  [EventType.STEP_FINISHED]: (ledger) => ledger.closes('step'),
  [EventType.TEXT_MESSAGE_START]: (ledger, event) => ledger.opens(`message:${about(event)}`),
  [EventType.TEXT_MESSAGE_CONTENT]: (ledger, event) => ledger.within(`message:${about(event)}`),
  [EventType.TEXT_MESSAGE_END]: (ledger, event) => ledger.closes(`message:${about(event)}`),
  [EventType.REASONING_MESSAGE_START]: (ledger, event) => ledger.opens(`message:${about(event)}`),
  [EventType.REASONING_MESSAGE_CONTENT]: (ledger, event) => ledger.within(`message:${about(event)}`),
  [EventType.REASONING_MESSAGE_END]: (ledger, event) => ledger.closes(`message:${about(event)}`),
  [EventType.REASONING_START]: (ledger, event) => ledger.opens(`span:${about(event)}`),
  [EventType.REASONING_END]: (ledger, event) => ledger.closes(`span:${about(event)}`),
  [EventType.TOOL_CALL_START]: (ledger, event) => ledger.opens(about(event)),
  [EventType.TOOL_CALL_ARGS]: callArgs,
  [EventType.TOOL_CALL_END]: (ledger, event) => ledger.closes(about(event)),
}

/** What the `answers` tier never carries. */
const FULL_ONLY = /^(?:REASONING_|TOOL_CALL_|STEP_|RAW$)/u

/** Every event valid, and the sequence well formed, as `tier` carries it; answers the events for chaining. */
export function checked(events: readonly AguiEvent[], tier: StreamTier = 'full'): readonly AguiEvent[] {
  const ledger = new Ledger()
  const args = new Map<string, number>()
  for (const event of events) {
    const parsed = EventSchema.safeParse(event)
    expect(parsed.success, `${event.type}: ${parsed.error?.message ?? ''}`).toBe(true)
    goblinParts(event, tier)
    if (tier === 'answers') expect(event.type).not.toMatch(FULL_ONLY)
    RULES[event.type]?.(ledger, event, args)
  }
  return events
}

/** `batches` translated in order from `cursor`, as one list of events, and the cursor after them. */
export function replay(cursor: StreamCursor, batches: Recording['batches']) {
  let at = cursor
  const events: AguiEvent[] = []
  for (const batch of batches) {
    const step = translate(at, batch)
    events.push(...step.events)
    at = step.cursor
  }
  return { events, cursor: at }
}

/** The text a message's content deltas add up to. */
export const textOf = (events: readonly AguiEvent[], messageId: string): string =>
  events
    .flatMap((event) =>
      (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.REASONING_MESSAGE_CONTENT) &&
      event.messageId === messageId
        ? [event.delta]
        : [],
    )
    .join('')
