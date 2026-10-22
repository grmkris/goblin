// A message's Details in the owner's words: how its turn ended, what goblin did, where it led and what it ran with,
// from the content-free inspection read (ADR 0024; ADR 0107 for what it ran with). Internals (flow names, event kinds,
// raw token pairs) stay with the CLI and /mcp inspection.
import type { InspectDetails, RelatedOperation, TurnStep } from '@goblin/contracts/inspect'
import type { ToolCallState } from '@goblin/ui'
import { ownToolLine } from './parts.ts'

/**
 * The outcome as a sentence around a duration, `before` it and `after` it with its own punctuation: "Answered in 3.5s",
 * "Failed after 4s: no answer came back", "Still working, 12s so far".
 */
export type DetailOutcome = {
  readonly before: string
  readonly ms?: number
  readonly running?: boolean
  readonly after?: string
}

/** One step as a line like the chat's tool rows, and where it sits on the turn's timeline (percent of its time). */
export type DetailStep = {
  readonly key: string
  readonly state: ToolCallState
  readonly lead: string
  /** What the step reached, said in the foreground: a model, or an MCP connection by its id (named by the caller). */
  readonly model?: string
  readonly server?: string
  readonly tool?: string
  readonly ms?: number
  readonly offsetMs: number
  readonly bar?: { readonly left: number; readonly width: number }
  /** Why it failed or was held, in the ledger's fixed words. */
  readonly problem?: string
  /** What changed under it: a restart into another release, its tools or instructions. */
  readonly note?: string
}

export type DetailRelated = { readonly operation: string; readonly label: string; readonly chat?: string }

export type DetailsView = {
  readonly outcome: DetailOutcome
  readonly steps: readonly DetailStep[]
  readonly related: readonly DetailRelated[]
  /** What the record cannot show, its sentences kept whole. */
  readonly gaps?: string
  /** Tokens, model endpoint, thinking level and release, as one quiet sentence. */
  readonly footer?: string
}

/** Why a turn ended unanswered, for the few reasons an owner can act on or recognise. */
const REASONS: Readonly<Record<string, string>> = {
  model_error: 'the model did not answer',
  unanswered: 'no answer came back',
  faulted: 'something went wrong',
  failed: 'something went wrong',
  expired: 'it ran out of time',
  inactive: 'goblin could not act for you',
}

function outcomeOf(details: InspectDetails, now: number): DetailOutcome {
  const { turn } = details
  if (turn === undefined) return { before: 'Nothing ran for this message; it was written directly.' }
  const ms = Math.max(0, (turn.endedAt ?? now) - turn.startedAt)
  const reason = turn.reason === undefined ? undefined : REASONS[turn.reason]
  switch (turn.status) {
    case 'ok':
      return { before: 'Answered in', ms }
    case 'started':
      return { before: 'Still working,', ms, running: true, after: ' so far' }
    case 'blocked':
      return { before: 'Waiting for you after', ms }
    case 'interrupted':
      return { before: 'Stopped after', ms }
    case 'error':
      return reason === undefined
        ? { before: 'Failed after', ms }
        : { before: 'Failed after', ms, after: `: ${reason}` }
  }
}

const STATES: Readonly<Record<TurnStep['status'], ToolCallState>> = {
  ok: 'done',
  error: 'error',
  started: 'running',
  blocked: 'stopped',
  interrupted: 'stopped',
}

/** A step's words: thought with a model, used a connection's tool or one of goblin's own, compacted, failed. */
function wordsOf(step: TurnStep): Pick<DetailStep, 'lead' | 'model' | 'server' | 'tool'> {
  switch (step.kind) {
    case 'model.attempt':
      return {
        lead: (step.attempt ?? 1) > 1 ? 'Tried again' : 'Thought',
        ...(step.model === undefined ? {} : { model: step.model }),
      }
    case 'tool.call':
      return step.server === undefined
        ? { lead: ownToolLine(step.tool ?? '') }
        : { lead: 'Used', server: step.server, ...(step.serverTool === undefined ? {} : { tool: step.serverTool }) }
    case 'compaction':
      return { lead: 'Summarized older messages' }
    case 'error':
      return { lead: 'Something failed' }
    // A turn's steps hold only its model attempts, tool calls, compactions and errors (`stepsOf`, inspect/inspector.ts).
    case 'turn.submitted':
    case 'model.aux':
    case 'mcp.request':
    case 'source.received':
    case 'source.reply':
    case 'recovery':
    case 'flow':
      return { lead: 'Recorded a step' }
  }
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** What changed under a step, plainly: a restart into another release, then its tools, then its instructions. */
function noteOf(step: TurnStep, previous: string | undefined): string | undefined {
  if (step.version !== undefined && previous !== undefined && step.version !== previous)
    return `goblin restarted into build ${step.version.slice(0, 7)} before this.`
  if (step.promptBaseline === true) return undefined
  const added = step.toolsAdded ?? 0
  const removed = step.toolsRemoved ?? 0
  if (added + removed > 0) {
    const parts = [added > 0 ? `${count(added, 'tool')} added` : '', removed > 0 ? `${removed} removed` : '']
    return `${parts.filter((part) => part !== '').join(', ')} before this.`
  }
  return (step.promptSections?.length ?? 0) > 0 ? 'Its instructions changed before this.' : undefined
}

function stepsOf(details: InspectDetails): DetailStep[] {
  const steps = details.steps ?? []
  const total = details.spent?.totalMs ?? 0
  // A single step's bar would only fill the width; bars say something once there are two to compare.
  const scaled = steps.length > 1 && total > 0
  let previous = details.turn?.version
  return steps.map((step, index) => {
    const note = noteOf(step, previous)
    previous = step.version ?? previous
    const problem = step.status === 'blocked' ? step.blockedReason : step.status === 'error' ? step.error : undefined
    const left = Math.min(100, (step.offsetMs / total) * 100)
    return {
      key: `${index}:${step.kind}:${step.offsetMs}`,
      state: STATES[step.status],
      ...wordsOf(step),
      ...(step.ms === undefined ? {} : { ms: step.ms }),
      offsetMs: step.offsetMs,
      ...(scaled
        ? {
            bar: {
              left,
              width: Math.min(100 - left, Math.max(0.5, ((step.ms ?? total - step.offsetMs) / total) * 100)),
            },
          }
        : {}),
      ...(problem === undefined ? {} : { problem }),
      ...(note === undefined ? {} : { note }),
    }
  })
}

/** Related operations by what they are to this one. */
const RELATED: Readonly<Record<string, string>> = {
  start: 'Started a thread',
  send: 'Started a thread',
  subagent_spawn: 'Started a subagent',
  persona_answer: 'A Persona answered',
  persona_ask: 'Answered for an earlier message',
  operation: 'Part of an earlier message',
}

const relatedOf = (related: RelatedOperation): DetailRelated => ({
  operation: related.operation,
  label: RELATED[related.kind] ?? 'Related',
  ...(related.chat === undefined ? {} : { chat: related.chat }),
})

const ENDPOINTS: Readonly<Record<string, string>> = {
  deployment: 'goblin’s model',
  owner: 'your own model endpoint',
  none: 'no model endpoint',
}
const TOKENS = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** "28k tokens on goblin's model, thinking low, build 393c895." Only what is known, nothing when nothing ran. */
function footerOf(details: InspectDetails): string | undefined {
  const { turn, ranWith } = details
  if (turn === undefined) return undefined
  const tokens = turn.inputTokens + turn.outputTokens
  const endpoint = ranWith?.endpoints[0]
  const thinking = ranWith?.thinking[0]
  const build = ranWith?.versions[0] ?? turn.version
  const parts = [
    `${tokens === 0 ? 'No' : TOKENS.format(tokens)} tokens${endpoint === undefined ? '' : ` on ${ENDPOINTS[endpoint] ?? endpoint}`}`,
    thinking === undefined ? '' : `thinking ${thinking}`,
    build === undefined ? '' : `build ${build.slice(0, 7)}`,
  ]
  return `${parts.filter((part) => part !== '').join(', ')}.`
}

/** A message's Details as the drawer shows them; `now` ends what still runs. */
export function detailsView(details: InspectDetails, now: number): DetailsView {
  const gaps = details.coverage.complete ? undefined : details.coverage.gaps.join(' ')
  const footer = footerOf(details)
  return {
    outcome: outcomeOf(details, now),
    steps: stepsOf(details),
    related: details.related.map(relatedOf),
    ...(gaps === undefined || gaps === '' ? {} : { gaps }),
    ...(footer === undefined ? {} : { footer }),
  }
}
