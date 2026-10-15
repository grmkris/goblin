// "Notify me via" (ADR 0066): the owner's choice of one tool of one connection that copies goblin's notices to them
// elsewhere (their own chat on a messaging server), with whole-leaf `{{text}}` and `{{operationId}}` placeholders. Set
// here and kept in `app_notify_sink`; the routines' notice copies move to it when the Telegram channel goes (ADR 0066,
// P7). Setting it grants its tool, as the owner chose it.
import { ArgumentsTemplate, type NotifySink, type NotifySinkView } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { epochSeconds } from '../clock.ts'
import { InvalidInput } from '../http/errors.ts'
import { McpConnections, McpGrants, McpServers } from '../mcp/service.ts'
import { Db } from '../runtime/db.ts'
import { appNotifySink } from '../storage/sources.ts'

const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(ArgumentsTemplate))

/** The sink as it is kept, or none while the owner has not chosen one (or its row does not decode). */
function notifySinkRow(db: DrizzleSqliteDODatabase): (NotifySink & { readonly updatedAt: number }) | undefined {
  const row = db.select().from(appNotifySink).where(eq(appNotifySink.id, 1)).get()
  if (row === undefined) return undefined
  const args = Option.getOrUndefined(decodeArguments(row.arguments))
  if (args === undefined) return undefined
  return { connectionId: row.connectionId, tool: row.tool, arguments: args, updatedAt: row.updatedAt }
}

/** `GET /api/notify-sink`: the sink with its connection's label, or null. */
export const notifySinkView = Effect.gen(function* () {
  const sink = notifySinkRow(yield* Db)
  if (sink === undefined) return null
  const labels = yield* (yield* McpServers).labels()
  return { ...sink, label: labels.get(sink.connectionId) ?? sink.connectionId } satisfies NonNullable<NotifySinkView>
})

/**
 * `PUT /api/notify-sink`: the owner's sink, on a connection they have and a tool it offers now (`InvalidInput`
 * otherwise); its tool is granted, as the owner chose it. The sink as it is now.
 */
export const setNotifySink = Effect.fn('sources.setNotifySink')(function* (sink: NotifySink) {
  const snapshot = yield* (yield* McpConnections).connect(sink.connectionId)
  if (!snapshot.tools.some((tool) => tool.name === sink.tool))
    return yield* new InvalidInput({ reason: `The connection does not offer the tool ${sink.tool}.` })
  yield* (yield* McpGrants).setTool(sink.connectionId, sink.tool, true)
  const db = yield* Db
  const row = {
    id: 1,
    connectionId: sink.connectionId,
    tool: sink.tool,
    arguments: JSON.stringify(sink.arguments),
    updatedAt: yield* epochSeconds,
  }
  db.insert(appNotifySink).values(row).onConflictDoUpdate({ target: appNotifySink.id, set: row }).run()
  return yield* notifySinkView
})

/** `DELETE /api/notify-sink`: no sink; the grant of its tool stays, as the owner may use it otherwise. */
export const clearNotifySink = Effect.gen(function* () {
  ;(yield* Db).delete(appNotifySink).run()
  return null
})
