import { ModelChoice } from '@goblin/contracts'
import { AgentGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import type { Applied } from '../../../src/agent-model.ts'
import { recordUse, usageLedger } from '../../../src/budget.ts'
import { registerPrimary } from '../../../src/chats/directory.ts'
import { AgentHandlers } from '../../../src/routines/agent-api.ts'
import { ChatsLive } from '../../../src/layers/conversation.ts'
import { ModelBudgetLive } from '../../../src/layers/budget.ts'
import { Cipher, CredentialCipher } from '../../../src/mcp/oauth/cipher.ts'
import { Resident } from '../../../src/mcp/service.ts'
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
  // The usage ledger the budget counts in, over the lane's database.
  const ledger = usageLedger(sqlite)
  const pinned: string[] = []
  const applied: Applied = new Map()
  const legacy = Layer.mergeAll(
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
          MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
          MODEL_KEY: 'unused',
          DAILY_TOKEN_CAP: '100000',
        },
        userId: 'owner',
        // An owner's model endpoint: it lists one model to any key.
        mcpFetch: async () => Response.json({ data: [{ id: 'own-model' }] }),
      }),
    ),
  )
  const { fetch } = serve(
    served([AgentGroup], AgentHandlers).pipe(
      Layer.provide(Layer.provideMerge(Layer.mergeAll(ModelBudgetLive, ChatsLive), legacy)),
    ),
  )
  return { fetch, ledger, pinned, applied }
}

/** The grant the edge forwards for a key with `scopes` (ADR 0081). */
const keyHeaders = (scopes: readonly string[]) => ({
  'x-goblin-key': JSON.stringify({ keyId: 'key-1', scopes, servers: [] }),
})

describe('the agent group served by the agent', () => {
  it("answers today's usage in tokens against the deployment's cap", async () => {
    const { fetch, ledger } = fixture()
    recordUse(ledger, { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, Math.floor(Date.now() / 1000))
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
      deployment: true,
      models: ['model-a', 'model-b'],
    })
    const key = 'sk-own-0123456789wxyz'
    const set = await fetch(json('PUT', '/api/agent/model-endpoint', { baseUrl: 'https://models.example/v1', key }))
    expect(set.status).toBe(200)
    const body = await set.text()
    expect(body).not.toContain(key)
    expect(JSON.parse(body)).toEqual({
      source: 'owner',
      deployment: true,
      baseUrl: 'https://models.example/v1',
      keyHint: '…wxyz',
      models: ['own-model'],
    })
    const choice = await callOwner({ fetch }, (api) => api.agent.model())
    expect(choice.options.map((option) => option.id)).toEqual(['own-model'])
    const plain = await fetch(json('PUT', '/api/agent/model-endpoint', { baseUrl: 'http://models.example', key }))
    expect(plain.status).toBe(400)
    const cleared = await callOwner({ fetch }, (api) => api.agent.clearModelEndpoint())
    expect(cleared).toEqual({ source: 'deployment', deployment: true, models: ['model-a', 'model-b'] })
  })

  it("answers the models a Persona may name, also to a server's key with the personas scope (ADR 0084)", async () => {
    const { fetch } = fixture()
    const offer = {
      default: 'model-a',
      models: [expect.objectContaining({ id: 'model-a' }), expect.objectContaining({ id: 'model-b' })],
    }
    expect(await callOwner({ fetch }, (api) => api.agent.models())).toEqual(offer)
    const answered = await fetch(json('GET', '/api/models', undefined, keyHeaders(['personas'])))
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual(offer)
    expect((await fetch(json('GET', '/api/models', undefined, keyHeaders(['topics'])))).status).toBe(403)
    // The owner's own pick is not a key's to read.
    expect((await fetch(json('GET', '/api/agent/model', undefined, keyHeaders(['personas'])))).status).toBe(403)
  })

  it('does not expose the retired channel routes', async () => {
    const { fetch } = fixture()
    for (const [method, path] of [
      ['GET', '/api/agent/channel'],
      ['PUT', '/api/agent/channel'],
      ['DELETE', '/api/agent/channel'],
      ['GET', '/api/agent/channel/chats'],
      ['PUT', '/api/agent/channel/routes'],
      ['PUT', '/api/agent/channel/settings'],
    ] as const) {
      const response = await fetch(json(method, path))
      expect(response.status, `${method} ${path}`).toBe(404)
    }
  })
})
