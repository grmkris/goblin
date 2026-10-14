import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from '../clock.ts'
import { FlowEvents } from '../observability/flows.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { type DeliveredReply, reportChannelFailure } from './channel.ts'
import { resubscribeEnded } from './program.ts'
import { onChannel } from './turns.ts'

// The Telegram channel's alarms, as the agent's schedule callbacks run them: each is one program through the bridge's
// `run`, its failure reported as a content-free line.

/** One answer's delivery to Telegram as a flow (ADR 0024): its turn, how many messages it took, and its failure. */
const deliveryFlow = (reply: DeliveredReply) =>
  FlowEvents.record({
    flow: 'telegram_delivery',
    via: 'telegram',
    actor: 'agent',
    operationId: reply.operationId,
    count: reply.pieces,
    status: reply.errorType === undefined ? 'ok' : 'error',
    ...(reply.errorType === undefined ? {} : { errorType: reply.errorType }),
  })

/**
 * The inbox read from its cursor and routed, while the channel is on; the channel takes one pull at a time. A
 * subscription the server ended is subscribed again first.
 */
export const pullChannel = onChannel((channel, ports) =>
  Effect.gen(function* () {
    // A subscription that cannot be made again (a revoked grant) marks the channel for the owner, once, not in a loop:
    // only a new event or the owner's switch pulls again.
    yield* resubscribeEnded.pipe(
      Effect.catch((error) =>
        Effect.andThen(
          Effect.sync(() => reportChannelFailure('resubscribe', error)),
          channel.ended,
        ),
      ),
    )
    yield* channel.pull(ports, yield* epochSeconds)
  }),
)

/**
 * The answers that are ready sent to Telegram, each recorded as a flow: the seconds until the next try while some are
 * still running, none when all went (or the channel is off).
 */
const sendReplies = Effect.gen(function* () {
  const context = yield* Effect.context<FlowEvents>()
  const delivered = (reply: DeliveredReply) => Effect.provideContext(deliveryFlow(reply), context)
  const running = yield* onChannel((channel, ports) =>
    Effect.flatMap(epochSeconds, (now) => channel.deliver(ports, now, delivered)),
  )
  return Option.getOrElse(running, () => false) ? 15 : undefined
})

/** `channelPull`: one pull; a failed one is reported, and the next event pulls again. */
export async function channelPull(run: RunProgram): Promise<void> {
  await run(Effect.asVoid(pullChannel)).catch((error: unknown) => reportChannelFailure('pull', error))
}

/** `channelReplies`: the ready answers sent; again in 15 s while some run, in 5 minutes after a failure. */
export async function channelReplies(run: RunProgram, again: (seconds: number) => Promise<unknown>): Promise<void> {
  const next = await run(sendReplies).catch((error: unknown) => {
    reportChannelFailure('replies', error)
    return 300
  })
  if (next !== undefined) await again(next)
}
