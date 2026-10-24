import { ModelChoice } from '@goblin/contracts'
import { AgentGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import type { Applied } from '../../../src/agent-model.ts'
import { recordUse, usageLedger } from '../../../src/budget.ts'
import { registerPrimary } from '../../../src/chats/directory.ts'
import { ChatOperations } from '../../../src/chats/service.ts'
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
import { credential, credentialHeaders } from '../../grants-fixture.ts'

const fixture = (owner: { readonly OWNER_WORKSPACE_ID?: string; readonly OWNER_MODELS?: string } = {}) => {
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
    // Asking main is the inbound tests'; here it only has to be served.
    stub(ChatOperations),
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
          ...owner,
        },
        workspaceId: 'owner',
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

/** The model ids a model choice answer offers. */
const ids = async (response: Response) =>
  Schema.decodeUnknownSync(ModelChoice)(await response.json()).options.map((option) => option.id)

/** An installed app's credential as the edge forwards it (ADR 0114), its grant `read`. */
const appHeaders = () => credentialHeaders(credential({ id: 'in-1', name: 'swarmm', level: 'read' }))

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

  it("answers the models a Persona may name, also to a server's key that reads (ADRs 0084, 0114)", async () => {
    const { fetch } = fixture()
    const offer = {
      default: 'model-a',
      models: [expect.objectContaining({ id: 'model-a' }), expect.objectContaining({ id: 'model-b' })],
    }
    expect(await callOwner({ fetch }, (api) => api.agent.models())).toEqual(offer)
    const answered = await fetch(json('GET', '/api/models', undefined, appHeaders()))
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual(offer)
    // The owner's own pick is not an app's to read.
    const pick = await fetch(json('GET', '/api/agent/model', undefined, appHeaders()))
    expect(pick.status).toBe(403)
    expect(await pick.json()).toMatchObject({ error: { code: 'forbidden', reason: 'credential' } })
  })

  it("offers the owner's own subscriptions to the owner alone, never to an installed app (ADR 0087)", async () => {
    const { fetch } = fixture({ OWNER_WORKSPACE_ID: 'owner', OWNER_MODELS: 'sub/claude-opus-5-5, model-b' })
    // model-b is every account's, so naming it among the owner's changes nothing.
    expect(await ids(await fetch(json('GET', '/api/agent/model')))).toEqual([
      'model-a',
      'model-b',
      'sub/claude-opus-5-5',
    ])
    const picked = await callOwner({ fetch }, (api) =>
      api.agent.chooseModel({ payload: { model: 'sub/claude-opus-5-5' } }),
    )
    expect(picked.options.find((option) => option.id === 'sub/claude-opus-5-5')).toMatchObject({
      route: 'Your subscription',
      images: true,
    })
    const keyed = await fetch(json('GET', '/api/models', undefined, appHeaders()))
    expect(await keyed.json()).toEqual({
      default: 'model-a',
      models: [expect.objectContaining({ id: 'model-a' }), expect.objectContaining({ id: 'model-b' })],
    })
  })

  it("never offers the owner's subscriptions to another account, nor lets it pick one", async () => {
    const { fetch } = fixture({ OWNER_WORKSPACE_ID: 'someone-else', OWNER_MODELS: 'sub/claude-opus-5-5' })
    const choice = Schema.decodeUnknownSync(ModelChoice)(await (await fetch(json('GET', '/api/agent/model'))).json())
    expect(choice.options.map((option) => option.id)).toEqual(['model-a', 'model-b'])
    const refused = await fetch(json('PUT', '/api/agent/model', { model: 'sub/claude-opus-5-5' }))
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'model' } })
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
