// A sink's delivery result is data interpreted only by the owner's saved rules, never by a server or tool name.
import type { SinkResultRules, SourceMatch } from '@goblin/contracts'
import type { McpToolResult } from '../mcp/connections/types.ts'
import { valueAt } from './pointer.ts'

/** A tool's acceptance is separate from remote delivery; unknown outcomes never authorize an automatic retry. */
export type SinkOutcome = 'accepted' | 'retryable' | 'rejected' | 'unknown'

const matches = (value: unknown, rule: SourceMatch | undefined): boolean =>
  rule !== undefined && valueAt(value, rule.pointer) === rule.equals

/** Interpret the structured result using exactly the owner-reviewed rules. No rules or ambiguous rules mean unknown. */
export function sinkOutcome(result: McpToolResult, rules: SinkResultRules | undefined): SinkOutcome {
  if (result.isError === true) return 'rejected'
  if (rules === undefined) return 'unknown'
  const found = (['accepted', 'retryable', 'rejected'] as const).filter((kind) =>
    matches(result.structuredContent, rules[kind]),
  )
  return found.length === 1 ? (found[0] ?? 'unknown') : 'unknown'
}

/** The server's requested retry time in epoch milliseconds, only used for an explicitly retryable outcome. */
export function sinkRetryAt(result: McpToolResult, rules: SinkResultRules | undefined): number {
  const at = rules?.retryAt === undefined ? undefined : valueAt(result.structuredContent, rules.retryAt)
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 ? at : 0
}
