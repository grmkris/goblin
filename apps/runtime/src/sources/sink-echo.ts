// An echo is an exact event selector on the sink's connection, never every service multiplexed by that connection.
import type { NotifySink, SourceWake } from '@goblin/contracts'
import { canonicalArguments } from '../mcp/events/store.ts'

/** Preserve the event name and canonical arguments so equivalent object key order has the same identity. */
export const sinkEventSelector = (wake: SourceWake): string => canonicalArguments([wake.event, wake.arguments])

/** The owner chose this stream as the sink's source; unrelated events on the same connection still get copies. */
export const sinkEcho = (
  sink: NotifySink,
  from: { readonly connectionId: string | null; readonly eventSelector: string | null },
): boolean =>
  sink.echo !== undefined &&
  sink.connectionId === from.connectionId &&
  sinkEventSelector(sink.echo) === from.eventSelector
