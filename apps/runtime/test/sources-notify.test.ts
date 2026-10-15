import { NotifySink } from '@goblin/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { McpConnections, McpGrants, McpServers } from '../src/mcp/service.ts'
import type { McpConnectionSnapshot } from '../src/mcp/types.ts'
import { Db } from '../src/runtime/db.ts'
import { clearNotifySink, notifySinkView, setNotifySink } from '../src/sources/notify.ts'
import { fake } from './fake.ts'
import { stub } from './http/api/fixture.ts'
import { sourceWorld } from './sources-fixture.ts'

const accepts = Schema.is(NotifySink)

/** The owner's own chat on a messaging server, as a Source's reply to the private chat fills it in. */
const DM = { connectionId: 'chat', tool: 'message_send', arguments: { chat: 'dm', text: '{{text}}' } }

describe('Notify me via (ADR 0066)', () => {
  it('takes `{{text}}` and `{{operationId}}` as whole values, and needs `{{text}}`', () => {
    expect(accepts(DM)).toBe(true)
    expect(accepts({ ...DM, arguments: { chat: 'dm', text: '{{text}}', operationId: '{{operationId}}' } })).toBe(true)
    expect(accepts({ ...DM, arguments: { chat: 'dm', text: 'goblin: {{text}}' } })).toBe(false)
    expect(accepts({ ...DM, arguments: { chat: '{{key.chat}}', text: '{{text}}' } })).toBe(false)
    expect(accepts({ ...DM, arguments: { chat: 'dm' } })).toBe(false)
  })

  it.effect("keeps the owner's choice, grants its tool, and forgets it on Clear", () =>
    Effect.gen(function* () {
      const { db } = yield* sourceWorld()
      const granted: string[] = []
      const snapshot = fake<McpConnectionSnapshot>({
        tools: [{ name: 'message_send', inputSchema: { type: 'object' } }],
      })
      const services = Layer.mergeAll(
        Layer.succeed(Db, db),
        stub(McpConnections, { connect: () => Effect.succeed(snapshot) }),
        stub(McpGrants, { setTool: (id, name) => Effect.sync(() => (granted.push(`${id}:${name}`), [])) }),
        stub(McpServers, { labels: () => Effect.succeed(new Map([['chat', 'Chat']])) }),
      )
      expect(yield* notifySinkView.pipe(Effect.provide(services))).toBeNull()
      expect(yield* setNotifySink(DM).pipe(Effect.provide(services))).toMatchObject({ ...DM, label: 'Chat' })
      expect(granted).toEqual(['chat:message_send'])
      const unknown = yield* Effect.flip(setNotifySink({ ...DM, tool: 'mail_send' }).pipe(Effect.provide(services)))
      expect(unknown).toMatchObject({ _tag: 'InvalidInput' })
      expect(yield* notifySinkView.pipe(Effect.provide(services))).toMatchObject({ tool: 'message_send' })
      yield* clearNotifySink.pipe(Effect.provide(services))
      expect(yield* notifySinkView.pipe(Effect.provide(services))).toBeNull()
    }),
  )
})
