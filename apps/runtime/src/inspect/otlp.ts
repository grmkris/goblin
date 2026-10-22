import type { TurnTimeline } from '@goblin/contracts/inspect'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { entriesToAttributes, make } from 'effect/observability/OtlpResource'
import type { TraceData } from 'effect/observability/OtlpTracer'

type ResourceSpans = TraceData['resourceSpans'][number]
type Span = ResourceSpans['scopeSpans'][number]['spans'][number]
type SpanEvent = Span['events'][number]

/** One operation of a trace: its run events, its turn among them, and Pi's settlement of it. */
export type TracedOperation = {
  readonly operationId: string
  readonly turn: RunEvent
  readonly events: readonly RunEvent[]
  readonly submission?: TurnTimeline['submission']
}

/** What a turn's trace is built from (ADR 0107): the turn, the turns it started, and where it ran. */
export type TraceInput = {
  /** The workspace whose agent ran it: part of the trace id, so two workspaces' operations never share one. */
  readonly workspace: string
  readonly stage?: string | undefined
  readonly root: TracedOperation
  /** The turns it started (a Persona's answer, a thread's first send), each under its root span. */
  readonly children: readonly TracedOperation[]
  /** The chat a Pi session belongs to, so a reader can page its entries (`inspect_conversation`). */
  readonly chatOf: (session: string) => string | undefined
  /** Ends what still runs. */
  readonly now: number
}

/** The most spans one trace holds; past it the rest are left out and the root says so. */
const MAX_SPANS = 2000

const SPAN_KIND = { internal: 1, client: 3 } as const
const STATUS = { unset: 0, ok: 1, error: 2 } as const
/** Pi's finish reasons as the GenAI conventions name them. */
const FINISH: Readonly<Record<string, string>> = { toolUse: 'tool_call' }
/** Attributes the ledger keeps comma-separated and a trace as lists. */
const LISTS: ReadonlySet<string> = new Set([RunAttribute.promptSections, RunAttribute.toolsChanged])
/** Kinds that are a span of their own; the rest are events on their operation's root span. */
const SPANNED: ReadonlySet<string> = new Set(['model.attempt', 'model.aux', 'tool.call', 'mcp.request', 'compaction'])

/** 32 bits of FNV-1a over `text` from `seed`. */
function fnv(text: string, seed: number): number {
  let hash = seed
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0
  }
  return hash
}

/** `words` × 32 bits of lowercase hex derived from `text`, never all zeros (an invalid OTLP id). */
function hexOf(text: string, words: number): string {
  const hex = Array.from({ length: words }, (_, word) =>
    fnv(text, (0x81_1c_9d_c5 + word * 0x9e_37_79_b9) >>> 0)
      .toString(16)
      .padStart(8, '0'),
  ).join('')
  return /^0+$/u.test(hex) ? `${hex.slice(0, -1)}1` : hex
}

const rootSpanId = (operationId: string) => hexOf(`root:${operationId}`, 2)
const spanIdOf = (event: RunEvent) => hexOf(`span:${event.id}`, 2)
const nanos = (ms: number) => (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString()
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * An event's attributes as a span's: the recorded ones, with finish reasons and name lists as lists and the first
 * chunk as seconds after the call started, and the ids a reader joins by: the Pi session (`gen_ai.conversation.id`),
 * its chat, the operation and the event.
 */
function attributesOf(event: RunEvent, chatOf: TraceInput['chatOf']): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event.attributes)) {
    if (key === RunAttribute.finishReason && typeof value === 'string') attributes[key] = [FINISH[value] ?? value]
    else if (key === RunAttribute.firstPartialAt && typeof value === 'number')
      attributes['gen_ai.response.time_to_first_chunk'] = Math.max(0, value - event.startedAt) / 1000
    else if (LISTS.has(key) && typeof value === 'string') attributes[key] = value.split(',')
    else attributes[key] = value
  }
  const chat = event.conversationId === undefined ? undefined : chatOf(event.conversationId)
  return {
    ...attributes,
    ...(event.conversationId === undefined ? {} : { 'gen_ai.conversation.id': event.conversationId }),
    ...(chat === undefined ? {} : { [RunAttribute.chat]: chat }),
    ...(event.operationId === undefined ? {} : { 'goblin.operation': event.operationId }),
    'goblin.event': event.id,
    'goblin.status': event.status,
  }
}

/** A span's name and kind, by the GenAI and MCP conventions. */
function nameOf(event: RunEvent): { readonly name: string; readonly kind: number } {
  const attribute = (key: string) => text(event.attributes[key])
  switch (event.kind) {
    case 'model.attempt':
    case 'model.aux':
      return { name: `chat ${attribute(RunAttribute.requestModel) ?? 'model'}`, kind: SPAN_KIND.client }
    case 'tool.call':
      return { name: `execute_tool ${attribute(RunAttribute.toolName) ?? 'tool'}`, kind: SPAN_KIND.internal }
    case 'mcp.request': {
      const method = attribute(RunAttribute.mcpMethod) ?? 'mcp'
      const tool = method === 'tools/call' ? attribute(RunAttribute.mcpTool) : undefined
      return { name: tool === undefined ? method : `${method} ${tool}`, kind: SPAN_KIND.client }
    }
    case 'turn.submitted':
      return { name: 'invoke_agent goblin', kind: SPAN_KIND.internal }
    case 'compaction':
    case 'error':
    case 'flow':
    case 'recovery':
    case 'source.received':
    case 'source.reply':
      return { name: event.kind, kind: SPAN_KIND.internal }
  }
}

function statusOf(event: RunEvent): Span['status'] {
  if (event.status === 'ok') return { code: STATUS.ok }
  if (event.status !== 'error') return { code: STATUS.unset }
  const message = text(event.attributes[RunAttribute.error]) ?? text(event.attributes[RunAttribute.reason])
  return message === undefined ? { code: STATUS.error } : { code: STATUS.error, message }
}

type Built = { readonly version: string | undefined; readonly span: Span }

/** One span of the trace: an event's name, times, status and attributes, under `parent`. */
function spanOf(
  event: RunEvent,
  ids: { readonly traceId: string; readonly spanId: string; readonly parent: string | undefined },
  input: TraceInput,
  extra: { readonly attributes?: Record<string, unknown>; readonly events?: SpanEvent[] } = {},
): Built {
  const { name, kind } = nameOf(event)
  return {
    version: text(event.attributes[RunAttribute.agentVersion]),
    span: {
      traceId: ids.traceId,
      spanId: ids.spanId,
      // OTLP's root has an empty parent; an absent value would reach JSON as `null`.
      parentSpanId: ids.parent ?? '',
      name,
      kind,
      startTimeUnixNano: nanos(event.startedAt),
      endTimeUnixNano: nanos(event.endedAt ?? Math.max(input.now, event.startedAt)),
      attributes: entriesToAttributes(Object.entries({ ...attributesOf(event, input.chatOf), ...extra.attributes })),
      droppedAttributesCount: 0,
      events: extra.events ?? [],
      droppedEventsCount: 0,
      status: statusOf(event),
      links: [],
      droppedLinksCount: 0,
    },
  }
}

/** An operation's spans: its root `invoke_agent goblin` under `parent`, its calls under it, the rest as root events. */
function operationSpans(operation: TracedOperation, traceId: string, parent: string | undefined, input: TraceInput) {
  const root = rootSpanId(operation.operationId)
  const toolSpans = new Map<string, string>()
  for (const event of operation.events)
    if (event.kind === 'tool.call' && event.taskId !== undefined) toolSpans.set(event.taskId, spanIdOf(event))
  const calls = operation.events.filter((event) => SPANNED.has(event.kind))
  const marks = operation.events.filter((event) => event !== operation.turn && !SPANNED.has(event.kind))
  const { submission } = operation
  const head = spanOf(operation.turn, { traceId, spanId: root, parent }, input, {
    attributes: {
      'gen_ai.agent.name': 'goblin',
      'gen_ai.agent.id': input.workspace,
      ...(submission?.entry === undefined ? {} : { 'goblin.submission.entry': submission.entry }),
      ...(submission?.answer === undefined ? {} : { 'goblin.submission.answer': submission.answer }),
    },
    events: marks.map((event) => ({
      name: event.kind === 'flow' ? `flow ${text(event.attributes[RunAttribute.flow]) ?? ''}`.trim() : event.kind,
      timeUnixNano: nanos(event.startedAt),
      attributes: entriesToAttributes(Object.entries(attributesOf(event, input.chatOf))),
      droppedAttributesCount: 0,
    })),
  })
  const inner = calls.map((event) => {
    const caller = event.kind === 'mcp.request' && event.taskId !== undefined ? toolSpans.get(event.taskId) : undefined
    return spanOf(event, { traceId, spanId: spanIdOf(event), parent: caller ?? root }, input)
  })
  return [head, ...inner]
}

/**
 * A turn as OpenTelemetry traces data (ADR 0107): its root span `invoke_agent goblin` (internal), each model attempt a
 * `chat {model}` span (client), each tool call an `execute_tool {tool}` span with the `{mcp.method.name} {tool}` span
 * (client) of the MCP request it made inside it, compactions as spans, and the rest (flow steps, errors, a Source's
 * messages, a restart) as events on the root. The turns it started nest under its root. One resource per release the
 * spans ran on, named `goblin` in its stage. Ids are derived, so the same turn is the same trace on every read. The
 * attributes are the run events' own: no content, and never the deployment endpoint's address, which the ledger never
 * keeps.
 */
export function traceOf(input: TraceInput): TraceData {
  const traceId = hexOf(`trace:${input.workspace}:${input.root.operationId}`, 4)
  const root = rootSpanId(input.root.operationId)
  const all = [
    ...operationSpans(input.root, traceId, undefined, input),
    ...input.children.flatMap((child) => operationSpans(child, traceId, root, input)),
  ]
  const kept = all.slice(0, MAX_SPANS)
  const head = kept[0]
  if (all.length > MAX_SPANS && head !== undefined) {
    const truncated = entriesToAttributes([[RunAttribute.truncated, true]])
    kept[0] = { ...head, span: { ...head.span, attributes: [...head.span.attributes, ...truncated] } }
  }
  const versions = [...new Set(kept.map((built) => built.version))]
  return {
    resourceSpans: versions.map((version) => ({
      resource: make({
        serviceName: 'goblin',
        serviceVersion: version,
        attributes: input.stage === undefined ? {} : { 'deployment.environment.name': input.stage },
      }),
      scopeSpans: [
        {
          scope: { name: 'goblin.run-ledger' },
          spans: kept.filter((built) => built.version === version).map((built) => built.span),
        },
      ],
    })),
  }
}
