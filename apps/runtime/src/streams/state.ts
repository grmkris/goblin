import type { Usage } from '@earendil-works/pi-ai'
import type { SnapshotEvent } from '@earendil-works/pi-durable'
import type {
  AgentView,
  CompactionsState,
  GenerationState,
  GoblinState,
  QueueItem,
  TokenCounts,
  UsageView,
} from '@goblin/contracts'

// The STATE document of a chat's stream from Pi's live documents: the queue (`pi.inbox`), the model call in flight
// (`pi.live.generation`), compactions (`pi.live.compactions`), the agent (`pi.agent`) and the spend (`pi.usage`).
// `/attention` is goblin's own reading of the entries (`attention.ts`).

/** The document before anything is known: empty queue, no call, no compaction, no model, no spend, nothing open. */
export const emptyState = (): GoblinState => ({
  queue: [],
  generation: null,
  compactions: { running: [], failure: null },
  agent: {},
  usage: { models: {}, tools: {} },
  attention: [],
})

type PiQueued = SnapshotEvent['inbox'][number]

/** The queued inputs; passive writes wait in the same queue and are left out. `texts` are their words, when read. */
export const queueView = (items: readonly PiQueued[], texts?: ReadonlyMap<number, string>): QueueItem[] =>
  items.flatMap(({ id, mode }) => {
    if (mode !== 'steer' && mode !== 'followUp') return []
    const text = texts?.get(Number(id))
    return [{ id: Number(id), mode, ...(text === undefined ? {} : { text }) }]
  })

/** The call in flight, without its partial (which the stream carries as the message itself). */
export const generationView = (generation: SnapshotEvent['generation']): GenerationState =>
  generation === undefined
    ? null
    : {
        attempt: generation.attempt,
        ...(generation.retry === undefined ? {} : { retry: generation.retry }),
        ...(generation.deferred === undefined ? {} : { deferred: generation.deferred }),
      }

/** Running compactions and the newest failure, without Pi's task ids. */
export const compactionsView = (
  running: SnapshotEvent['compactions'],
  failure: SnapshotEvent['compactionFailure'],
): CompactionsState => ({
  running: running.map(({ reason, blocking, attempt, retry }) => ({
    reason,
    blocking,
    attempt,
    ...(retry === undefined ? {} : { retry }),
  })),
  failure: failure === undefined ? null : { reason: failure.reason, error: failure.error },
})

/** The model and thinking level; extensions, tool filters and instructions are the runtime's own business. */
export const agentView = (agent: SnapshotEvent['agent']): AgentView => ({
  ...(agent.model === undefined ? {} : { model: { provider: agent.model.provider, modelId: agent.model.modelId } }),
  ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
})

type Counted = Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens' | 'reasoning'>

/** Pi's token counters without its prices. */
export const tokenCounts = (usage: Counted): TokenCounts => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  totalTokens: usage.totalTokens,
  ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
})

const countsOf = (buckets: Readonly<Record<string, Counted>>): Record<string, TokenCounts> =>
  Object.fromEntries(Object.entries(buckets).map(([key, usage]) => [key, tokenCounts(usage)]))

/** The chat's spend by model and by tool. */
export const usageView = (usage: SnapshotEvent['usage']): UsageView => ({
  models: countsOf(usage.models),
  tools: countsOf(usage.tools),
})

/** `usage` added to `total`, counter by counter; `reasoning` once either side reports it. */
export function addCounts(total: TokenCounts | undefined, usage: TokenCounts): TokenCounts {
  if (total === undefined) return usage
  const reasoning =
    total.reasoning === undefined && usage.reasoning === undefined
      ? undefined
      : (total.reasoning ?? 0) + (usage.reasoning ?? 0)
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

/** The whole document a snapshot shows, with `attention` as goblin read it from the entries. */
export const stateOf = (
  snapshot: SnapshotEvent,
  attention: GoblinState['attention'],
  texts?: ReadonlyMap<number, string>,
): GoblinState => ({
  queue: queueView(snapshot.inbox, texts),
  generation: generationView(snapshot.generation),
  compactions: compactionsView(snapshot.compactions, snapshot.compactionFailure),
  agent: agentView(snapshot.agent),
  usage: usageView(snapshot.usage),
  attention,
})
