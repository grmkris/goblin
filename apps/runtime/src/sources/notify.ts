// "Notify me via" (ADR 0066): the owner's choice of one tool of one connection that sends goblin's notices to them
// elsewhere (their own chat on a messaging server), with whole-leaf `{{text}}` and `{{operationId}}` placeholders. Set
// here and kept in `app_notify_sink`; setting it grants its tool, as the owner chose it. A routine's notice copies and
// an agent app's `notify` power send through it (ADR 0070), as goblin's own call under that grant.
import { ArgumentsTemplate, type NotifySink, type NotifySinkView, fillTemplate } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { epochSeconds } from '../clock.ts'
import { Forbidden, InvalidInput } from '../http/errors.ts'
import { McpConnections, McpGrants, McpServers, requireResident } from '../mcp/service.ts'
import { bound } from '../runtime/boundary.ts'
import { Db } from '../runtime/db.ts'
import { isRecord, sha256Hex } from '../runtime/digest.ts'
import { appNotifySink } from '../storage/sources.ts'

const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(ArgumentsTemplate))

/** The sink as it is kept: the owner's choice and when they made it (seconds). */
type KeptSink = NotifySink & { readonly updatedAt: number }

/** The sink as it is kept, or none while the owner has not chosen one (or its row does not decode). */
function notifySinkRow(db: DrizzleSqliteDODatabase): KeptSink | undefined {
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

/** The sink as it is kept now, or none while the owner has not set one. */
export const notifySink = Db.useSync(notifySinkRow)

/**
 * The sink's revision: when it was set and a digest of what it says, so a copy frozen on one notices any change since,
 * a save of the same choice included (ADR 0070).
 */
export const sinkRevision = (sink: KeptSink) =>
  Effect.map(
    Effect.promise(() => sha256Hex(JSON.stringify([sink.connectionId, sink.tool, sink.arguments]))),
    (digest) => `${String(sink.updatedAt)}:${digest.slice(0, 16)}`,
  )

/**
 * Resident authority, and the sink still at `revision` (`Forbidden` when it changed or was cleared): what each send
 * checks before its call and again right before the call leaves. The sink as it is.
 */
const sinkAt = (revision: string) =>
  Effect.gen(function* () {
    yield* requireResident
    const sink = yield* notifySink
    if (sink === undefined || (yield* sinkRevision(sink)) !== revision)
      return yield* new Forbidden({ reason: 'notify sink changed' })
    return sink
  })

/** What one send says: its words and its operation id, how long its call may take, and the sink's frozen revision. */
type SinkSend = {
  readonly revision: string
  readonly text: string
  readonly operationId: string
  readonly timeout: number
}

/**
 * `send.text` to the owner through the sink at `send.revision` (ADR 0070): its template filled with the words and the
 * operation id (whole values, as the server formats them), as goblin's own call under the owner's grant of its tool
 * (`caller: 'model'`, so a tool set to Ask first refuses it). Resident authority and the sink are checked before and
 * again right before the call leaves; a sink changed or cleared since is `Forbidden`. The server's answer, `isError` and
 * all.
 */
export const sendThroughSink = Effect.fn('sources.sendThroughSink')(function* (send: SinkSend) {
  const sink = yield* sinkAt(send.revision)
  const authorize = yield* bound(Effect.asVoid(sinkAt(send.revision)))
  const filled = fillTemplate(sink.arguments, { text: send.text, operationId: send.operationId })
  return yield* (yield* McpConnections).callTool(sink.connectionId, sink.tool, isRecord(filled) ? filled : {}, {
    caller: 'model',
    timeout: send.timeout,
    authorize,
  })
})
