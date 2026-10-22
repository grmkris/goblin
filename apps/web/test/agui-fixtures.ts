// A chat's stream for the web's tests, written as the runtime writes it (`apps/runtime/src/streams/`): messages with
// goblin's marks, the events of an epoch's opening, and the live events of a run. The runtime's own goldens
// (`apps/runtime/test/streams/__snapshots__`) are read by `agui-reducer.test.ts`; these builders are for the cases a
// test spells out itself.
import { type ConversationProjection, Projector } from '../src/lib/agui/reducer.ts'

export type Wire = Record<string, unknown>
export const CHAT = '1'

const goblin = (marks: Record<string, unknown>) => ({ metadata: { goblin: marks } })

/** A user message of entry `entry` (the owner's unless `marks` says who wrote it). */
export const said = (entry: number, content: string, marks: Record<string, unknown> = {}): Wire => ({
  id: `${CHAT}:e${entry}`,
  role: 'user',
  content,
  ...goblin({ entryId: entry, branchable: true, ...marks }),
})

/** A tool call an assistant message asks for: `mcp_call` unless named. */
export type CallSpec = { readonly id: string; readonly name?: string; readonly arguments?: unknown }
const toolCall = ({ id, name = 'mcp_call', arguments: args = {} }: CallSpec) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

type AnswerSpec = {
  readonly text?: string
  readonly calls?: readonly CallSpec[]
  readonly thinking?: readonly string[]
  readonly at?: number
  readonly marks?: Record<string, unknown>
}

/** The assistant message of entry `entry`: its thinking messages first, then its words and the calls it asks for. */
export function answer(entry: number, { text, calls = [], thinking = [], at = 1_000, marks = {} }: AnswerSpec): Wire[] {
  const id = `${CHAT}:a${at}`
  return [
    ...thinking.map((thought, index) => ({ id: `${id}:r${index}`, role: 'reasoning', content: thought })),
    {
      id,
      role: 'assistant',
      ...(text === undefined ? {} : { content: text }),
      ...(calls.length === 0 ? {} : { toolCalls: calls.map(toolCall) }),
      ...goblin({ entryId: entry, at, branchable: true, ...marks }),
    },
  ]
}

/** An assistant message asking for `calls` and saying nothing. */
export const asking = (entry: number, calls: readonly CallSpec[], at = 1_000): Wire[] => answer(entry, { calls, at })

type ResultSpec = {
  readonly content?: string
  readonly isError?: boolean
  readonly details?: unknown
  readonly toolName?: string
  readonly at?: number
}

/** The result of call `toolCallId`, entry `entry`. */
export const result = (
  entry: number,
  toolCallId: string,
  { content = 'out', isError = false, details, toolName = 'mcp_call', at = 4_500 }: ResultSpec = {},
): Wire => ({
  id: `${CHAT}:t${toolCallId}`,
  role: 'tool',
  toolCallId,
  content,
  ...goblin({ entryId: entry, at, toolName, isError, ...(details === undefined ? {} : { details }) }),
})

/** An entry the app draws itself (`ActivityType`). */
export const activity = (
  entry: number,
  activityType: string,
  content: unknown,
  marks: Record<string, unknown> = {},
): Wire => ({
  id: `${CHAT}:e${entry}`,
  role: 'activity',
  activityType,
  content,
  ...goblin({ entryId: entry, ...marks }),
})

type Opening = {
  readonly running?: boolean
  readonly queue?: readonly Wire[]
  readonly generation?: Wire | null
  readonly before?: number
}

/** The events an epoch opens with: its messages, its STATE and, when one is in flight, its run. */
export function opening(
  messages: readonly (Wire | readonly Wire[])[],
  { running = false, queue = [], generation = null, before }: Opening = {},
): Wire[] {
  return [
    { type: 'MESSAGES_SNAPSHOT', messages: messages.flat(), ...(before === undefined ? {} : goblin({ before })) },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        queue,
        generation,
        compactions: { running: [], failure: null },
        agent: {},
        usage: { models: {}, tools: {} },
        attention: [],
      },
    },
    ...(running ? [{ type: 'RUN_STARTED', threadId: CHAT, runId: `${CHAT}:1` }] : []),
  ]
}

/** A chat followed from its opening: `next` applies more events (stamped `now`) and answers the projection. */
export function follow(messages: readonly (Wire | readonly Wire[])[], options: Opening = {}) {
  const projector = new Projector()
  const first = projector.apply(opening(messages, options), 0)
  return { first, next: (events: readonly Wire[], now = 0): ConversationProjection => projector.apply(events, now) }
}

/** The projection of an epoch's opening alone. */
export const snapshot = (
  messages: readonly (Wire | readonly Wire[])[],
  options: Opening = {},
): ConversationProjection => follow(messages, options).first

/** A tool's first progress: it started executing. */
export const started = (toolCallId: string): Wire => ({
  type: 'CUSTOM',
  name: 'goblin.tool_progress',
  value: { toolCallId, status: 'running' },
})

/** The run ends. */
export const finished: Wire = { type: 'RUN_FINISHED', threadId: CHAT, runId: `${CHAT}:1` }

/** The assistant message `at` begins streaming: thinking `thought` (when given), then words `text`. */
export function streaming(
  at: number,
  { thought, text }: { readonly thought?: string; readonly text?: string },
): Wire[] {
  const id = `${CHAT}:a${at}`
  const marks = goblin({ at })
  return [
    ...(thought === undefined
      ? []
      : [
          { type: 'REASONING_START', messageId: `${id}:s0` },
          { type: 'REASONING_MESSAGE_START', messageId: `${id}:r0`, role: 'reasoning', ...marks },
          { type: 'REASONING_MESSAGE_CONTENT', messageId: `${id}:r0`, delta: thought },
        ]),
    ...(text === undefined
      ? []
      : [
          ...(thought === undefined
            ? []
            : [
                { type: 'REASONING_MESSAGE_END', messageId: `${id}:r0` },
                { type: 'REASONING_END', messageId: `${id}:s0` },
              ]),
          { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant', ...marks },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text },
        ]),
  ]
}
