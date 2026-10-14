import { ModelChoice } from '@goblin/contracts'
import { AgentGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import type { Applied } from '../../../src/agent-model.ts'
import { ModelBudget, usageLedger } from '../../../src/budget.ts'
import { telegramChannel } from '../../../src/channel/channel.ts'
import { Channel } from '../../../src/channel/service.ts'
import { registerPrimary } from '../../../src/chats/directory.ts'
import { AgentHandlers } from '../../../src/routines/agent-api.ts'
import { AppEngine } from '../../../src/agent-apps/service.ts'
import { ChatOperations, Conversations } from '../../../src/chats/service.ts'
import { FlowEvents } from '../../../src/observability/flows.ts'
import { Receipts } from '../../../src/organize/service.ts'
import { Invocations, Personas } from '../../../src/personas/service.ts'
import { Setups } from '../../../src/setup/service.ts'
import { Skills } from '../../../src/skills/service.ts'
import { Topics } from '../../../src/topics/service.ts'
import { ChatsLive } from '../../../src/layers/conversation.ts'
import { ModelBudgetLive } from '../../../src/layers/budget.ts'
import { Cipher, CredentialCipher } from '../../../src/mcp/cipher.ts'
import { Events, McpConnections, McpGrants, McpServers, Resident } from '../../../src/mcp/service.ts'
import { PiSessions } from '../../../src/pi/sessions.ts'
import { Db } from '../../../src/runtime/db.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import { callOwner } from '../../owner-client.ts'
import { durable } from '../../chats-sqlite.ts'
import { currentResident, database, json, serve, served, stub } from './fixture.ts'

const fixture = () => {
  const db = database()
  const sqlite = durable(db)
  registerPrimary(db, 1)
  const budget = new ModelBudget(usageLedger(sqlite), null)
  const pinned: string[] = []
  const applied: Applied = new Map()
  const legacy = Layer.mergeAll(
    Layer.effect(
      Channel,
      // The channel's status and disable read and clear its tables only.
      telegramChannel({ db: sqlite, telemetry: undefined, wake: () => undefined }),
    ),
    // The channel's tools: the server offers none, so turning the channel on is refused before anything is granted.
    stub(McpServers, { tools: () => Effect.succeed([]), list: () => Effect.succeed([]) }),
    stub(McpConnections, { snapshot: () => Effect.succeedNone }),
    stub(McpGrants),
    stub(Events, { activeConsumer: () => Effect.succeedNone }),
    // Routes reach Topics, Personas and their chats only while the channel is on; these are never used here.
    stub(Topics),
    stub(Personas),
    stub(Invocations),
    stub(Receipts),
    stub(ChatOperations),
    stub(Conversations),
    stub(FlowEvents),
    stub(Skills),
    stub(AppEngine),
    stub(Setups),
    // The database the lane builds its stores over, the cipher sealing a model key, and the gate's resident authority.
    Layer.succeed(Db, sqlite),
    Layer.effect(
      Cipher,
      Effect.promise(() => CredentialCipher.fromBase64(btoa('\0'.repeat(32)))),
    ),
    Layer.succeed(Resident, currentResident().service),
    // Choosing a model only puts the primary session on it; nothing else of Pi is reached.
    stub(PiSessions, { setModel: (session, { id }) => Effect.sync(() => void pinned.push(`${session} ${id}`)) }),
    // The agent handlers read only these from the instance input.
    Layer.succeed(
      AgentInput,
      Object.assign(Object.create(null), {
        applied,
        env: {
          APP_URL: 'https://goblin.test',
          CREDENTIAL_KEY: 'unused',
          MODELS: 'model-b',
          MODEL_ID: 'model-a',
          DAILY_TOKEN_CAP: '100000',
        },
        userId: 'owner',
        // An owner's model endpoint: it lists one model to any key.
        mcpFetch: async () => Response.json({ data: [{ id: 'own-model' }] }),
        schedulePull: async () => undefined,
      }),
    ),
  )
  const { fetch } = serve(
    served([AgentGroup], AgentHandlers).pipe(
      Layer.provide(Layer.provideMerge(Layer.mergeAll(ModelBudgetLive, ChatsLive), legacy)),
    ),
  )
  return { fetch, budget, pinned, applied }
}

describe('the agent group served by the agent', () => {
  it("answers today's usage in tokens against the deployment's cap", async () => {
    const { fetch, budget } = fixture()
    budget.record({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, Math.floor(Date.now() / 1000))
    const response = await fetch(json('GET', '/api/agent/usage'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ used: 5000, limit: 100_000 })
  })

  it('reads the model choice, moves main to a pick at once, and refuses a model not on offer', async () => {
    const { fetch, pinned, applied } = fixture()
    const choice = Schema.decodeUnknownSync(ModelChoice)(await (await fetch(json('GET', '/api/agent/model'))).json())
    expect(choice).toMatchObject({ current: 'model-a', default: 'model-a' })
    expect(choice.options.map((option) => option.id)).toEqual(['model-a', 'model-b'])
    const picked = await callOwner({ fetch }, (api) => api.agent.chooseModel({ payload: { model: 'model-b' } }))
    expect(picked.current).toBe('model-b')
    expect(pinned).toEqual([`${[...applied.keys()].join()} model-b`])
    const refused = await fetch(json('PUT', '/api/agent/model', { model: 'not-offered' }))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'model' } })
    const empty = await fetch(json('PUT', '/api/agent/model', { model: '' }))
    expect(empty.status).toBe(400)
  })

  it("sets the owner's own model endpoint, never answers its key, refuses a plain http one, and removes it", async () => {
    const { fetch } = fixture()
    expect(await callOwner({ fetch }, (api) => api.agent.modelEndpoint())).toEqual({
      source: 'deployment',
      models: ['model-a', 'model-b'],
    })
    const key = 'sk-own-0123456789wxyz'
    const set = await fetch(json('PUT', '/api/agent/model-endpoint', { baseUrl: 'https://models.example/v1', key }))
    expect(set.status).toBe(200)
    const body = await set.text()
    expect(body).not.toContain(key)
    expect(JSON.parse(body)).toEqual({
      source: 'owner',
      baseUrl: 'https://models.example/v1',
      keyHint: '…wxyz',
      models: ['own-model'],
    })
    const choice = await callOwner({ fetch }, (api) => api.agent.model())
    expect(choice.options.map((option) => option.id)).toEqual(['own-model'])
    const plain = await fetch(json('PUT', '/api/agent/model-endpoint', { baseUrl: 'http://models.example', key }))
    expect(plain.status).toBe(400)
    const cleared = await callOwner({ fetch }, (api) => api.agent.clearModelEndpoint())
    expect(cleared).toEqual({ source: 'deployment', models: ['model-a', 'model-b'] })
  })

  it('answers the channel as null while off, refuses a connection without its tools, and turns it off', async () => {
    const { fetch } = fixture()
    const status = await fetch(json('GET', '/api/agent/channel'))
    expect(status.status).toBe(200)
    expect(await status.text()).toBe('null')
    const refused = await fetch(json('PUT', '/api/agent/channel', { connectionId: 'myagent' }))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: { code: 'invalid_input', reason: "myagent does not offer Telegram's inbox_read and message_send" },
    })
    const off = await fetch(json('DELETE', '/api/agent/channel'))
    expect(off.status).toBe(200)
    expect(await off.text()).toBe('null')
    expect(await callOwner({ fetch }, (api) => api.agent.channel())).toBeNull()
  })

  it('refuses the Chats list, a route and the new-chats default while the channel is off', async () => {
    const { fetch } = fixture()
    const chats = await fetch(json('GET', '/api/agent/channel/chats'))
    expect(chats.status).toBe(400)
    expect(await chats.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'telegram_off' } })
    const route = await fetch(json('PUT', '/api/agent/channel/routes', { chat: 'g_abc', mode: 'ignore' }))
    expect(route.status).toBe(400)
    expect(await route.json()).toMatchObject({ error: { reason: 'telegram_off' } })
    const settings = await fetch(json('PUT', '/api/agent/channel/settings', { newChats: 'topic' }))
    expect(settings.status).toBe(400)
    const unnamed = await fetch(json('PUT', '/api/agent/channel/routes', { chat: 'g_abc', mode: 'answer' }))
    expect(unnamed.status).toBe(400)
  })
})
