import type { InspectDetails, RelatedOperation, TurnRanWith } from '@goblin/contracts/inspect'
import { RunAttribute, type RunEvent, type RunEventStatus } from '@goblin/contracts/telemetry'
import { durationText } from './format.ts'

/**
 * One step of what ran behind a message, in the owner's words: what it was, what it touched, how it ended, and where
 * it sits on the turn's timeline (`bar`: from its start to its end, as percents of the turn's wall time).
 */
export type DetailStep = {
  readonly id: string
  readonly label: string
  readonly detail: string | undefined
  readonly status: RunEventStatus
  readonly ms: number | undefined
  readonly offsetMs?: number
  readonly bar?: { readonly left: number; readonly width: number }
}

const attribute = (event: RunEvent, key: string): string | undefined => {
  const value = event.attributes[key]
  return value === undefined || value === '' ? undefined : String(value)
}

const named = (what: string, ...names: readonly (string | undefined)[]): string => {
  const name = names.filter((each) => each !== undefined).join(' · ')
  return name === '' ? what : `${what} ${name}`
}

/** What a step was: the model it asked, the tool it called, the flow it took. */
function labelOf(event: RunEvent): string {
  switch (event.kind) {
    case 'turn.submitted':
      return 'Message submitted'
    case 'model.attempt':
      return named('Model', attribute(event, RunAttribute.responseModel) ?? attribute(event, RunAttribute.requestModel))
    case 'model.aux':
      return named('Helper model', attribute(event, RunAttribute.purpose))
    case 'tool.call':
      return named('Tool', attribute(event, RunAttribute.toolName))
    case 'compaction':
      return 'Context compacted'
    case 'source.received':
      return named('Received from', attribute(event, RunAttribute.source))
    case 'source.reply':
      return named('Replied on', attribute(event, RunAttribute.source))
    case 'recovery':
      return 'Recovered'
    case 'mcp.request':
      return named('MCP', attribute(event, RunAttribute.mcpServer), attribute(event, RunAttribute.mcpTool))
    case 'error':
      return 'Error'
    case 'flow':
      return named('Flow', attribute(event, RunAttribute.flow))
  }
}

/** Whether the prompt or the tools changed before a model attempt; a restatement after compaction is no change. */
const changedBefore = (event: RunEvent): boolean =>
  event.attributes[RunAttribute.promptBaseline] !== true &&
  [RunAttribute.promptSections, RunAttribute.toolsAdded, RunAttribute.toolsRemoved].some(
    (key) => event.attributes[key] !== undefined,
  )

/** What else is worth a line under a step: why it failed, its tokens, how a flow came in, what changed before it. */
function detailOf(event: RunEvent): string | undefined {
  const failure = attribute(event, RunAttribute.errorType) ?? attribute(event, RunAttribute.blockedReason)
  if (failure !== undefined) return failure
  if (event.kind === 'flow') return attribute(event, RunAttribute.flowVia)
  const input = event.attributes[RunAttribute.inputTokens]
  const output = event.attributes[RunAttribute.outputTokens]
  const tokens =
    typeof input === 'number' && typeof output === 'number' ? `${input} in · ${output} out tokens` : undefined
  const changed =
    event.kind === 'model.attempt' && changedBefore(event) ? 'prompt or tools changed before it' : undefined
  const parts = [tokens, changed].filter((part) => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Where a step sits on its turn's timeline, as percents of the turn's wall time; none without a turn. */
function barOf(event: RunEvent, start: number, total: number, now: number) {
  const left = Math.min(100, Math.max(0, ((event.startedAt - start) / total) * 100))
  const end = event.endedAt ?? now
  const width = Math.min(100 - left, Math.max(0.5, ((end - event.startedAt) / total) * 100))
  return { left, width }
}

/** The steps of a message's operation, in the order they ran, placed on its turn's timeline when it ran one. */
export function detailSteps(details: InspectDetails, now: number = Date.now()): DetailStep[] {
  const start = details.turn?.startedAt
  const total = details.spent?.totalMs ?? 0
  return details.events
    .toSorted((a, b) => a.startedAt - b.startedAt)
    .map((event) => ({
      id: event.id,
      label: labelOf(event),
      detail: detailOf(event),
      status: event.status,
      ms: event.endedAt === undefined ? undefined : event.endedAt - event.startedAt,
      ...(start === undefined || total <= 0
        ? {}
        : { offsetMs: Math.max(0, event.startedAt - start), bar: barOf(event, start, total, now) }),
    }))
}

/** A release's commit as git abbreviates it. */
const short = (version: string) => version.slice(0, 7)

const ENDPOINTS: Readonly<Record<string, string>> = {
  deployment: 'goblin’s model endpoint',
  owner: 'your own model endpoint',
  none: 'no model endpoint',
}

/**
 * What a turn ran with in a line (ADR 0107): its release, endpoint, thinking level and MCP servers as they report
 * themselves, and what changed under it: a restart into a new release mid-turn, a prompt or tool change before an
 * attempt.
 */
export function ranWithText(ranWith: TurnRanWith): string {
  const [first, ...later] = ranWith.versions
  const parts = [
    first === undefined ? undefined : `Build ${short(first)}`,
    ...later.map((version) => `restarted into ${short(version)}`),
    ...ranWith.endpoints.map((endpoint) => ENDPOINTS[endpoint] ?? endpoint),
    ranWith.thinking.length === 0 ? undefined : `thinking ${ranWith.thinking.join(', ')}`,
    ranWith.promptChanges === 0
      ? undefined
      : `prompt or tools changed before ${ranWith.promptChanges} attempt${ranWith.promptChanges === 1 ? '' : 's'}`,
    ...ranWith.servers.map((server) => [server.name ?? server.server, server.version].filter(Boolean).join(' ')),
  ]
  return parts.filter((part) => part !== undefined && part !== '').join(' · ')
}

const counted = (count: number, one: string, failed = 0) =>
  `${count} ${one}${count === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}`

/** The operation in a few lines: where it came from and how it ended, what it took, what it cost. */
export function detailSummary(details: InspectDetails): string[] {
  const { turn } = details
  if (turn === undefined) return ['A written note: no model ran for it.']
  const ended = turn.endedAt === undefined ? 'still running' : durationText(turn.endedAt - turn.startedAt)
  const ranWith = details.ranWith === undefined ? '' : ranWithText(details.ranWith)
  return [
    `From ${turn.source} · ${turn.status}${turn.reason === undefined ? '' : ` (${turn.reason})`} · ${ended}`,
    `${counted(turn.modelAttempts, 'model attempt', turn.failedAttempts)} · ${counted(turn.toolCalls, 'tool call', turn.failedToolCalls)}`,
    `${turn.inputTokens} in · ${turn.outputTokens} out tokens${(turn.errors ?? 0) > 0 ? ` · ${counted(turn.errors ?? 0, 'error')}` : ''}`,
    ...(ranWith === '' ? [] : [`Ran with ${ranWith}`]),
  ]
}

/** A related operation in a line: what it was, and where it stands. */
export const relatedText = (related: RelatedOperation): string =>
  related.state === undefined ? related.kind : `${related.kind} · ${related.state}`
