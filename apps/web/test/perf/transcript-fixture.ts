/**
 * A deterministic synthetic conversation for the performance harness, as the chat's AG-UI stream carries it: the
 * messages its epoch opens with, and a reply streamed as batches of events. Shared by the runner (`../ui-perf.ts`, which
 * serves the stream) and the page (`transcript.tsx`, which plays the batches), so both sides agree on what the
 * transcript holds.
 */

import { marksOf } from '../../src/lib/agui/messages.ts'

/** When the synthetic conversation starts (epoch ms); each turn is a minute after the last. */
const START = 1_760_000_000_000

const QUESTIONS = [
  'Can you compare the two hosting plans we looked at yesterday and say which one fits the side project?',
  'Summarise what changed in the release notes since the last version I installed.',
  'Write a small TypeScript helper that groups an array of records by a key.',
  'What is the difference between a Durable Object alarm and a Cron Trigger?',
  'Draft a short reply to the landlord about the heating repair next week.',
  'Plan a three-day trip to Ljubljana with one rainy-day option.',
]

const PROSE = [
  'Here is the short version first, then the detail you can skim if you want it.',
  'Both options work, but they trade cost against how much you have to look after yourself.',
  'I checked the notes you saved earlier and the numbers below come from those, not from memory.',
  'The main thing to watch is the limit on concurrent requests, which only bites under load.',
]

const CODE = [
  '```ts',
  'export function groupBy<T, K extends PropertyKey>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {',
  '  const groups = {} as Record<K, T[]>',
  '  for (const item of items) (groups[key(item)] ??= []).push(item)',
  '  return groups',
  '}',
  '```',
].join('\n')

const TABLE = [
  '| Plan | Monthly | Requests | Notes |',
  '| --- | ---: | ---: | --- |',
  '| Starter | $5 | 10M | shared CPU, fine for a hobby project |',
  '| Standard | $25 | 50M | dedicated CPU, daily backups |',
  '| Business | $90 | 250M | support with a response-time promise |',
].join('\n')

const DIAGRAM = [
  '```mermaid',
  'flowchart LR',
  '  A[Request] --> B{Cached?}',
  '  B -- yes --> C[Reply]',
  '  B -- no --> D[Origin] --> C',
  '```',
].join('\n')

/** One assistant answer in Markdown, varied by turn so the transcript mixes prose, lists, code, tables and figures. */
function answer(turn: number): string {
  const prose = PROSE[turn % PROSE.length] ?? ''
  const list = [
    '- **First**, the part that matters most.',
    '- *Second*, a caveat with `inline code`.',
    '- Third, a [link](https://example.com/docs).',
  ].join('\n')
  const parts = [`### Turn ${turn + 1}`, prose, list]
  if (turn % 3 === 0) parts.push(CODE)
  if (turn % 3 === 1) parts.push(TABLE)
  if (turn % 12 === 5) parts.push(DIAGRAM)
  parts.push('> Quoted from the saved note, so you can check it against the source.', prose)
  return parts.join('\n\n')
}

/** A message or event as the chat's stream carries it (AG-UI, docs/architecture/streams.md). */
type Wire = Record<string, unknown>
const CHAT = '1'
const marks = (goblin: Record<string, unknown>) => ({ metadata: { goblin } })
const USAGE = { input: 900, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 }

const user = (entry: number, at: number, text: string): Wire => ({
  id: `${CHAT}:e${entry}`,
  role: 'user',
  content: text,
  ...marks({ entryId: entry, at, branchable: true }),
})
const callOf = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})
type Call = ReturnType<typeof callOf>
/** An assistant message of `entry`: its thinking first, then its words and calls. */
const assistant = (
  entry: number,
  at: number,
  { text, thinking, calls = [] }: { text?: string; thinking?: string; calls?: readonly Call[] },
): Wire[] => [
  ...(thinking === undefined ? [] : [{ id: `${CHAT}:a${at}:r0`, role: 'reasoning', content: thinking }]),
  {
    id: `${CHAT}:a${at}`,
    role: 'assistant',
    ...(text === undefined ? {} : { content: text }),
    ...(calls.length === 0 ? {} : { toolCalls: calls }),
    ...marks({ entryId: entry, at, branchable: true, usage: USAGE }),
  },
]
const FETCHED = `# Fetched page\n\n${PROSE.join(' ')}\n\n${TABLE}`
const toolResult = (entry: number, at: number, call: string, toolName = 'web_fetch'): Wire => ({
  id: `${CHAT}:t${call}`,
  role: 'tool',
  toolCallId: call,
  content: FETCHED,
  ...marks({ entryId: entry, at, toolName, isError: false }),
})

/** A conversation of at least `parts` transcript rows, with how many it has: every other turn calls a tool first. */
export function history(parts: number): { readonly entries: readonly Wire[]; readonly parts: number } {
  const entries: Wire[] = []
  let rows = 0
  let id = 1
  for (let turn = 0; rows < parts; turn += 1) {
    const at = START + turn * 60_000
    entries.push(user(id++, at, QUESTIONS[turn % QUESTIONS.length] ?? ''))
    if (turn % 2 === 1) {
      const call = `call-${turn}`
      const thinking = 'The saved notes probably have this; fetch the page to be sure.'
      const request = callOf(call, 'web_fetch', { url: 'https://example.com/plans' })
      entries.push(...assistant(id++, at + 1_000, { thinking, calls: [request] }), toolResult(id++, at + 2_000, call))
      rows += 2 // the Thoughts and the tool card; the result folds into the card
    }
    entries.push(...assistant(id++, at + 3_000, { text: answer(turn) }))
    rows += 2 // the question and the answer
  }
  return { entries, parts: rows }
}

/** The newest entry `messages` hold. */
export const lastEntry = (messages: readonly Wire[]): number =>
  Math.max(0, ...messages.map((message) => marksOf(message).entryId ?? 0))

const STATE = {
  queue: [],
  generation: null,
  compactions: { running: [], failure: null },
  agent: {},
  usage: { models: {}, tools: {} },
  attention: [],
}
/** The events the stream's epoch opens with: the whole history, nothing running. */
export const snapshot = (entries: readonly Wire[]): Wire[] => [
  { type: 'MESSAGES_SNAPSHOT', messages: entries },
  { type: 'STATE_SNAPSHOT', snapshot: STATE },
]

/** The reply the Stream scenario plays: about 4,800 characters with every block kind, including a figure. */
export function streamedReply(): string {
  return Array.from({ length: 8 }, (_, turn) => answer(turn)).join('\n\n')
}

/** Characters per batch: pi-durable commits a partial at most every 100 ms; ~50 characters is a brisk model's pace. */
export const BATCH_CHARACTERS = 48
/** pi-durable's partial throttle (`PARTIAL_THROTTLE_MS`), which the stream's 250 ms coalescing follows closely enough. */
export const BATCH_INTERVAL_MS = 100

/** A user message committed whole, as the stream writes one. */
const said = (message: Wire): Wire[] => [
  { type: 'TEXT_MESSAGE_START', messageId: message.id, role: 'user', metadata: message.metadata },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: message.id, delta: message.content },
  { type: 'TEXT_MESSAGE_END', messageId: message.id, metadata: message.metadata },
]
const RUN = { threadId: CHAT, runId: `${CHAT}:run` }
const started = { type: 'RUN_STARTED', ...RUN }
const finished = { type: 'RUN_FINISHED', ...RUN }
/** The answer `at` begins. */
const opened = (at: number): Wire => ({
  type: 'TEXT_MESSAGE_START',
  messageId: `${CHAT}:a${at}`,
  role: 'assistant',
  ...marks({ at }),
})
const textUpdate = (at: number, delta: string): Wire => ({
  type: 'TEXT_MESSAGE_CONTENT',
  messageId: `${CHAT}:a${at}`,
  delta,
})
/** The answer `at` ends as entry `entry`. */
const ended = (at: number, entry: number): Wire => ({
  type: 'TEXT_MESSAGE_END',
  messageId: `${CHAT}:a${at}`,
  ...marks({ entryId: entry, branchable: true, usage: USAGE }),
})

/**
 * The batches of one owner turn and its streamed reply, as the stream carries them: the owner's message, the run
 * starting, the reply growing a slice at a time, then its end and the run's end.
 */
export function streamBatches(lastId: number): readonly (readonly Wire[])[] {
  const at = START + 10_000_000
  const reply = streamedReply()
  const batches: Wire[][] = [
    [started, ...said(user(lastId + 1, at, 'Pull it all together into one overview I can keep.'))],
  ]
  batches.push([opened(at + 1_000)])
  for (let offset = 0; offset < reply.length; offset += BATCH_CHARACTERS)
    batches.push([textUpdate(at + 1_000, reply.slice(offset, offset + BATCH_CHARACTERS))])
  batches.push([ended(at + 1_000, lastId + 2), finished])
  return batches
}

/** One step of a scripted stream: a batch, how long the server stays quiet after it, and the dock's height from then on. */
export type Step = { readonly batch: readonly Wire[]; readonly wait: number; readonly dock?: string }
const step = (batch: readonly Wire[], wait = BATCH_INTERVAL_MS, dock?: string): Step => ({
  batch,
  wait,
  ...(dock !== undefined && { dock }),
})

/** The reply's text, `BATCH_CHARACTERS` at a time, into the answer `at`. */
function textSteps(reply: string, at: number): Step[] {
  const steps: Step[] = []
  for (let offset = 0; offset < reply.length; offset += BATCH_CHARACTERS)
    steps.push(step([textUpdate(at, reply.slice(offset, offset + BATCH_CHARACTERS))]))
  return steps
}

/** Scenarios of one owner turn that the follow runner (`../ui-follow.ts`) plays against the real transcript. */
export const FOLLOW_SCENARIOS = [
  'reply',
  'tools',
  'tool-storm',
  'long-first',
  'dock',
  'same-batch',
  'resnapshot',
] as const
export type FollowScenario = (typeof FOLLOW_SCENARIOS)[number]

/**
 * `reply`: the baseline, a streamed answer. `tools`: a slow provider, thinking, a tool that takes a while, then the
 * answer. `tool-storm`: three rounds of thinking and four parallel tool calls that finish one after another, then the
 * answer: a turn of the kind that fills a screen with rows. `long-first`: the answer is already longer than the screen
 * when its first batch arrives. `dock`: the baseline while the composer grows (a queued message, an attachment) partway
 * through. `same-batch`: the owner's turn and more than a screen of its reply arrive together (a Source turn, a queued
 * one starting). `resnapshot`: the stream moves to a new epoch whose opening already holds the turn and a long partial
 * reply, which then keeps streaming.
 */
export function followSteps(scenario: FollowScenario, entries: readonly Wire[]): readonly Step[] {
  return SCENARIOS[scenario](turnOf(entries))
}

/** When the scripted owner turn starts (the fixture's clock). */
const TURN_AT = START + 10_000_000
/** How much of the reply the scenarios that start with a long one deliver in their first batch. */
const FIRST_SLICE = 2_400
const THINKING = 'The saved notes probably have this; fetch the page to be sure.'

/** The owner turn a scenario plays: the history it follows, its message, and the reply it streams. */
type Turn = {
  readonly entries: readonly Wire[]
  readonly lastId: number
  readonly question: Wire
  readonly opening: Step
  readonly reply: string
}
function turnOf(entries: readonly Wire[]): Turn {
  const lastId = lastEntry(entries)
  const question = user(lastId + 1, TURN_AT, 'Pull it all together into one overview I can keep.')
  return { entries, lastId, question, opening: step([started, ...said(question)]), reply: streamedReply() }
}

/** Thinking streaming in for the answer `at`, as the two batches that start the block and then fill it. */
const thinkingSteps = (at: number, thinking: string): Step[] => [
  step([
    { type: 'REASONING_START', messageId: `${CHAT}:a${at}:s0` },
    { type: 'REASONING_MESSAGE_START', messageId: `${CHAT}:a${at}:r0`, role: 'reasoning', ...marks({ at }) },
  ]),
  step([{ type: 'REASONING_MESSAGE_CONTENT', messageId: `${CHAT}:a${at}:r0`, delta: thinking }]),
]
/** The thinking of the answer `at` ends, and the answer asks for `calls` and ends as entry `entry`. */
const asked = (at: number, entry: number, calls: readonly Call[]): Step =>
  step([
    { type: 'REASONING_MESSAGE_END', messageId: `${CHAT}:a${at}:r0` },
    { type: 'REASONING_END', messageId: `${CHAT}:a${at}:s0` },
    opened(at),
    ...calls.map((call) => ({
      type: 'TOOL_CALL_START',
      toolCallId: call.id,
      toolCallName: call.function.name,
      parentMessageId: `${CHAT}:a${at}`,
    })),
    ended(at, entry),
    ...calls.flatMap((call) => [
      { type: 'TOOL_CALL_ARGS', toolCallId: call.id, delta: call.function.arguments },
      { type: 'TOOL_CALL_END', toolCallId: call.id },
    ]),
  ])
const running = (call: string): Wire => ({
  type: 'CUSTOM',
  name: 'goblin.tool_progress',
  value: { toolCallId: call, status: 'running' },
})
/** A tool's result committed as entry `entry`. */
const resulted = (result: Wire): Wire => ({
  type: 'TOOL_CALL_RESULT',
  messageId: result.id,
  toolCallId: result.toolCallId,
  content: result.content,
  role: 'tool',
  metadata: result.metadata,
})
/** The reply committing and the run ending. */
const committed = (entry: number, at: number): Step => step([ended(at, entry), finished])

const streamed = (turn: Turn): Step[] => [
  turn.opening,
  step([opened(TURN_AT + 1_000)]),
  ...textSteps(turn.reply, TURN_AT + 1_000),
  committed(turn.lastId + 2, TURN_AT + 1_000),
]

/** A slow provider, thinking, one tool that takes a while, then the answer. */
function tools(turn: Turn): Step[] {
  const call = 'call-follow'
  const request = callOf(call, 'web_fetch', { url: 'https://example.com/plans' })
  const at = TURN_AT + 1_000
  return [
    { ...turn.opening, wait: 3_000 }, // the provider's quiet stretch before anything streams
    ...thinkingSteps(at, THINKING),
    asked(at, turn.lastId + 2, [request]),
    step([running(call)], 1_500),
    step([resulted(toolResult(turn.lastId + 3, TURN_AT + 2_500, call))], 2_500),
    step([opened(TURN_AT + 3_000)]),
    ...textSteps(turn.reply, TURN_AT + 3_000),
    committed(turn.lastId + 4, TURN_AT + 3_000),
  ]
}

const STORM_TOOLS = ['list_messages', 'list_tasks', 'list_gaps', 'whoami']
/** One round of the storm: the model thinks, asks for four calls to one server, and they finish one by one. */
function stormRound(round: number, firstId: number): Step[] {
  const when = TURN_AT + 1_000 + round * 10_000
  const calls = STORM_TOOLS.map((name, index) =>
    callOf(`storm-${round}-${index}`, 'mcp_call', { connectionId: 'dev-sidequest-exchange', name, arguments: {} }),
  )
  return [
    ...thinkingSteps(when, 'Checking the next set of pages.'),
    asked(when, firstId, calls),
    step(
      calls.map((one) => running(one.id)),
      400,
    ),
    ...calls.map((one, index) =>
      step([resulted(toolResult(firstId + 1 + index, when + 2_000, one.id, 'mcp_call'))], 250),
    ),
  ]
}
/** Each round takes an entry for the asking message and one per result. */
const STORM_ROUND_ENTRIES = STORM_TOOLS.length + 1

function toolStorm(turn: Turn): Step[] {
  const rounds = [0, 1, 2].flatMap((round) => stormRound(round, turn.lastId + 2 + round * STORM_ROUND_ENTRIES))
  const answerId = turn.lastId + 2 + 3 * STORM_ROUND_ENTRIES
  return [
    turn.opening,
    ...rounds,
    step([opened(TURN_AT + 40_000)]),
    ...textSteps(turn.reply, TURN_AT + 40_000),
    committed(answerId, TURN_AT + 40_000),
  ]
}

/** The owner's turn and the start of the reply in one batch, so the reply is already past the fold when it lands. */
const sameBatch = (turn: Turn): Step[] => [
  step([
    started,
    ...said(turn.question),
    opened(TURN_AT + 1_000),
    textUpdate(TURN_AT + 1_000, turn.reply.slice(0, FIRST_SLICE)),
  ]),
  ...textSteps(turn.reply.slice(FIRST_SLICE), TURN_AT + 1_000),
  committed(turn.lastId + 2, TURN_AT + 1_000),
]

/** A new epoch whose opening already holds the turn and a long partial reply, as after the stream moved. */
const resnapshot = (turn: Turn): Step[] => [
  step([
    { type: 'MESSAGES_SNAPSHOT', messages: [...turn.entries, turn.question] },
    { type: 'STATE_SNAPSHOT', snapshot: STATE },
    started,
    opened(TURN_AT + 1_000),
    textUpdate(TURN_AT + 1_000, turn.reply.slice(0, FIRST_SLICE)),
  ]),
  ...textSteps(turn.reply.slice(FIRST_SLICE), TURN_AT + 1_000),
  committed(turn.lastId + 2, TURN_AT + 1_000),
]

/** The baseline, with the composer growing a third of the way through. */
function dockGrows(turn: Turn): Step[] {
  const steps = streamed(turn)
  const third = Math.floor(steps.length / 3)
  return steps.map((one, index) => (index === third ? { ...one, dock: '11rem' } : one))
}

const SCENARIOS: Record<FollowScenario, (turn: Turn) => Step[]> = {
  reply: streamed,
  tools,
  'tool-storm': toolStorm,
  'long-first': (turn) => [
    turn.opening,
    step([opened(TURN_AT + 1_000), textUpdate(TURN_AT + 1_000, turn.reply.slice(0, FIRST_SLICE))]),
    ...textSteps(turn.reply.slice(FIRST_SLICE), TURN_AT + 1_000),
    committed(turn.lastId + 2, TURN_AT + 1_000),
  ],
  dock: dockGrows,
  'same-batch': sameBatch,
  resnapshot,
}

/** What the page saw of the scroller over one scripted turn (`transcript.tsx`). */
export type FollowReport = {
  readonly frames: number
  /** How far the newest row's bottom is below the clear area above the composer, at the worst frame (px; > 0 is hidden). */
  readonly hiddenMax: number
  /** The same, once the stream had finished and settled. */
  readonly hiddenFinal: number
  /** Whether the jump-to-end arrow was offered once it had settled. */
  readonly arrowFinal: boolean
  /** Frames in which the arrow was offered while the reply was still streaming. */
  readonly arrowFrames: number
  /** Frames where the scroll position moved back up, and by how much at most (px); content above the screen settling does it too. */
  readonly backFrames: number
  readonly backMax: number
  /** Times the gap between two rows both on screen changed from one frame to the next (a row grew or one was inserted between), and the biggest change (px). */
  readonly shifts: number
  readonly shiftMax: number
  /** The tallest the reserved space under a pinned turn got (px). */
  readonly spacerMax: number
  /** How many rows the turn that was just played takes, from the owner's message to the end. */
  readonly turnRows: number
  /** What happened, frame by frame: the view pulled back, the arrow toggled, the newest row shrank, rows jumped on screen. */
  readonly trace: readonly string[]
}

/** What the page measured over one recorded stretch. */
export type Sample = {
  frames: number[]
  longTasks: number[]
  inputs: number[]
  commits: number
  commitMs: number
}
/** The page's controls (`transcript.tsx`), which the runner drives. */
export type PerfApi = {
  /** When the transcript first showed whole (ms since navigation). */
  ready?: number | undefined
  start(): void
  stop(): Sample
  /** Plays one owner turn and its streamed reply after entry `lastId`. */
  stream(lastId: number): Promise<void>
  /** Plays a scripted turn while watching the scroller, and says what it saw. */
  follow(steps: readonly Step[]): Promise<FollowReport>
}
declare global {
  interface Window {
    readonly perf: PerfApi
  }
}
