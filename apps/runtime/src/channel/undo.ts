// Undo of a Telegram route or of the new-chats default (ADRs 0033, 0055): the receipt's `before` put back through the
// channel (sources/undo.ts). A route goes back with no delivery: what a chat holds waits only while it has no route,
// and a receipt's change always leaves one.
import { NewChatsDefault, TelegramRoute } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { epochSeconds } from '../clock.ts'
import { InvalidInput } from '../http/errors.ts'
import { undoRoute } from '../sources/undo.ts'
import type { RouteChoice } from './routes.ts'
import { Channel } from './service.ts'

const RouteSnapshot = Schema.Struct({ route: Schema.NullOr(TelegramRoute) })
const DefaultSnapshot = Schema.Struct({ newChats: NewChatsDefault })

/** A route receipt's target, `<chat>:<thread>`, as its key. */
const keyOf = (target: string) => {
  const split = target.lastIndexOf(':')
  return { chat: target.slice(0, split), thread: Number(target.slice(split + 1)) }
}

/**
 * Undoes a Telegram receipt: the route (or the default for new chats) goes back to what it was before. Refused as
 * `touched` (409) once anything changed it since the receipt (`afterRevision`); `InvalidInput` while the channel is
 * off or for a snapshot that does not decode.
 */
export const undoTelegram = (receipt: {
  readonly kind: 'telegram.route' | 'telegram.default'
  readonly target: string
  readonly before: unknown
  readonly afterRevision: number
}) =>
  Effect.gen(function* () {
    const channel = yield* Channel
    if ((yield* channel.status) === null) return yield* new InvalidInput({ reason: 'telegram_off' })
    const current = yield* channel.revision(receipt.kind, receipt.target)
    if (receipt.kind === 'telegram.default')
      return yield* undoRoute(receipt, current, DefaultSnapshot, ({ newChats }) =>
        Effect.asVoid(channel.newChats(newChats)),
      )
    yield* undoRoute(receipt, current, RouteSnapshot, ({ route }) =>
      Effect.flatMap(epochSeconds, (now) => {
        const choice: RouteChoice = route ?? { mode: 'inherit' }
        return Effect.asVoid(channel.restore(keyOf(receipt.target), choice, now))
      }),
    )
  })
