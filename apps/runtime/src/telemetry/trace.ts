import { RunAttribute, type RunAttributes, type RunEvent } from '@goblin/contracts/telemetry'
import { writeLine } from '../observability/logger.ts'
import { MAX_FAILURE_LINES, type RunSink } from './events.ts'
import { expectedFailure, sanitizeAttributes } from './safety.ts'

/**
 * The part of a Cloudflare span the sink uses (`cloudflare:workers` `tracing`), injected so tests need no workerd. An
 * older local workerd's span has no `setStatus`; the status is in `goblin.status` either way.
 */
export type TraceSpan = {
  /** Whether the runtime records it: false outside a traced request, or when the request was not sampled. */
  readonly isTraced?: boolean
  setAttributes(attributes: Record<string, string | number | boolean | undefined>): unknown
  setStatus?: (status: { readonly code: 'unset' | 'ok' | 'error'; readonly message?: string }) => unknown
  end(): void
}
export type Tracer = { startSpan(name: string): TraceSpan; getActiveSpan?: () => unknown }

const AGENT_NAME = 'goblin'

const text = (value: RunAttributes[string] | undefined) => (typeof value === 'string' ? value : '')

/**
 * The OpenTelemetry GenAI span a run event becomes, or none: a model call is `chat {model}`, a tool call is
 * `execute_tool {tool}`. Turns, MCP steps and Source events stay in the ledger and logs; they span invocations.
 */
export function spanNameOf(event: RunEvent): string | undefined {
  if (event.kind === 'model.attempt' || event.kind === 'model.aux')
    return `chat ${text(event.attributes[RunAttribute.requestModel]) || 'model'}`
  if (event.kind === 'tool.call') return `execute_tool ${text(event.attributes[RunAttribute.toolName]) || 'tool'}`
  return undefined
}

/**
 * Run events as spans in the Cloudflare trace of the invocation where they end (ADR 0024): the same GenAI attribute
 * names, plus the agent, conversation and operation ids. A model or tool call often starts in one invocation (Pi admits
 * it) and ends in another, and a Workers span cannot outlive its invocation or take a start time, so each call is one
 * span written whole at its end, its real start and duration in `goblin.started_at` and `goblin.duration_ms`. Ids,
 * numbers, names and bounded error text only; never content.
 */
export class TraceSink implements RunSink {
  readonly name = 'trace'
  readonly #tracer: Tracer
  readonly #agent: () => string
  #untraced = 0

  constructor(tracer: Tracer, agent: () => string) {
    this.#tracer = tracer
    this.#agent = agent
  }

  started(): void {}

  ended(event: RunEvent): void {
    const name = spanNameOf(event)
    if (name === undefined) return
    const attributes = sanitizeAttributes(event.attributes)
    const span = this.#tracer.startSpan(name)
    if (span.isTraced === false) this.#reportUntraced(event)
    span.setAttributes({
      ...attributes,
      'gen_ai.agent.name': AGENT_NAME,
      'gen_ai.agent.id': this.#agent(),
      'gen_ai.conversation.id': event.conversationId,
      'goblin.operation': event.operationId,
      'goblin.event': event.id,
      'goblin.status': event.status,
      'goblin.started_at': event.startedAt,
      'goblin.duration_ms': event.endedAt === undefined ? undefined : Math.max(0, event.endedAt - event.startedAt),
    })
    const message = text(attributes[RunAttribute.error]) || text(attributes[RunAttribute.reason])
    span.setStatus?.(
      event.status === 'ok' || event.status === 'blocked' || expectedFailure(attributes[RunAttribute.errorType])
        ? { code: event.status === 'ok' ? 'ok' : 'unset' }
        : { code: 'error', message },
    )
    span.end()
  }

  /**
   * A span the runtime will not record, as one `failure` line, up to `MAX_FAILURE_LINES` per object: `no_active_span`
   * when it was made in an async context outside any request (no span is active), `unsampled` when its request was not
   * sampled. Why a turn's calls never reach Traces (docs/architecture/observability.md).
   */
  #reportUntraced(event: RunEvent): void {
    this.#untraced += 1
    if (this.#untraced > MAX_FAILURE_LINES) return
    writeLine('warn', {
      event: 'failure',
      where: 'telemetry.trace.untraced',
      kind: event.kind,
      code: this.#tracer.getActiveSpan?.() === undefined ? 'no_active_span' : 'unsampled',
      severity: 'Warn',
    })
  }
}
