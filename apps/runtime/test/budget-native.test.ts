import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach } from 'vitest'
import { Budget } from '../src/budget.ts'
import { Inference } from '../src/inference/service.ts'
import { ModelBudgetLive } from '../src/layers/budget.ts'
import { Cipher, CredentialCipher } from '../src/mcp/oauth/cipher.ts'
import { Models } from '../src/models.ts'
import { AgentInput } from '../src/runtime/input.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const KEY = btoa(String.fromCharCode(...new Uint8Array(32)))
const OWNER_KEY = 'sk-owner-0123456789abcd'

/** An owner's endpoint at `https://models.example`: it lists `ids` to the owner's key and refuses any other. */
const endpointFetch =
  (ids: readonly string[]): typeof fetch =>
  async (_input, init) => {
    const authorization = new Headers(init?.headers).get('authorization')
    return authorization === `Bearer ${OWNER_KEY}`
      ? Response.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) })
      : new Response('no', { status: 401 })
  }

/** The deployment's own model endpoint, as its settings name it. */
const DEPLOYMENT_MODEL = {
  MODEL_ID: 'model-a',
  MODEL_BASE_URL: 'https://litellm.example/v1',
  MODEL_KEY: 'deployment-key',
}

/**
 * The model endpoint, the budget and the model picker over SQLite, as the agent builds them, with the deployment's
 * `cap`; an owner endpoint is reached through `mcpFetch`. `house: false` is a deployment without its own endpoint.
 */
const lane = (cap?: string, mcpFetch: typeof fetch = endpointFetch([]), house = true) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  return ModelBudgetLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        sqliteDb(db),
        Layer.effect(
          Cipher,
          Effect.promise(() => CredentialCipher.fromBase64(KEY)),
        ),
        // These layers read only the deployment's model settings, the owner and the outbound fetch.
        Layer.succeed(
          AgentInput,
          Object.assign(Object.create(null), {
            env: {
              ...(house ? DEPLOYMENT_MODEL : {}),
              ...(cap === undefined ? {} : { DAILY_TOKEN_CAP: cap }),
            },
            userId: 'owner',
            mcpFetch,
          }),
        ),
      ),
    ),
  )
}

const NOW = 86_400 * 20_000 + 60
const TOKENS = { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }

describe('the model usage the agent checks', () => {
  it.effect(
    "counts today's tokens against the deployment's cap, refuses once it is reached and allows the next day",
    () =>
      Effect.gen(function* () {
        const budget = yield* Budget
        yield* budget.record(TOKENS, NOW)
        expect(yield* budget.today(NOW)).toEqual({ used: 5000, limit: 8000, resetsAt: 86_400 * 20_001 })
        yield* budget.require(NOW)
        yield* budget.record(TOKENS, NOW)
        expect(yield* Effect.flip(budget.require(NOW))).toMatchObject({
          _tag: 'BudgetExhausted',
          limit: 8000,
          resetsAt: 86_400 * 20_001,
        })
        expect(yield* budget.today(NOW + 86_400)).toMatchObject({ used: 0 })
        yield* budget.require(NOW + 86_400)
      }).pipe(Effect.provide(lane('8000'))),
  )

  it.effect('refuses nothing without a cap', () =>
    Effect.gen(function* () {
      const budget = yield* Budget
      yield* budget.record({ ...TOKENS, input: 50_000_000 }, NOW)
      expect(yield* budget.today(NOW)).toMatchObject({ used: 50_000_000, limit: null })
      yield* budget.require(NOW)
    }).pipe(Effect.provide(lane())),
  )

  it.effect("offers the deployment's models", () =>
    Effect.gen(function* () {
      const choice = yield* Models.use((models) => models.choice).pipe(Effect.provide(lane()))
      expect(choice.options.map((option) => option.id)).toEqual(['model-a'])
    }),
  )
})

describe("the owner's own model endpoint", () => {
  it.effect("sends every call to the owner's endpoint once it lists its models, with no cap, until removed", () =>
    Effect.gen(function* () {
      const inference = yield* Inference
      expect(yield* inference.served('model-a')).toEqual({
        baseUrl: 'https://litellm.example/v1',
        apiKey: 'deployment-key',
        model: 'model-a',
      })
      const view = yield* inference.setOwner({ baseUrl: 'https://models.example/v1/', key: OWNER_KEY }, NOW)
      expect(view).toEqual({
        source: 'owner',
        deployment: true,
        baseUrl: 'https://models.example/v1',
        keyHint: '…abcd',
        models: ['gpt-x', 'gpt-y'],
      })
      expect(JSON.stringify(view)).not.toContain(OWNER_KEY)
      // A model the endpoint serves is sent as asked; any other as the endpoint's first.
      expect(yield* inference.served('gpt-y')).toEqual({
        baseUrl: 'https://models.example/v1',
        apiKey: OWNER_KEY,
        model: 'gpt-y',
      })
      expect((yield* inference.served('model-a')).model).toBe('gpt-x')
      const choice = yield* Models.use((models) => models.choice)
      expect(choice.options.map((option) => option.id)).toEqual(['gpt-x', 'gpt-y'])
      // The deployment's cap holds for its own endpoint only.
      const budget = yield* Budget
      yield* budget.record({ ...TOKENS, input: 9000 }, NOW)
      expect(yield* budget.today(NOW)).toMatchObject({ used: 9000, limit: null })
      yield* budget.require(NOW)
      expect(yield* inference.clearOwner).toEqual({ source: 'deployment', deployment: true, models: ['model-a'] })
      expect(yield* Effect.flip(budget.require(NOW))).toMatchObject({ _tag: 'BudgetExhausted', limit: 8000 })
      expect((yield* inference.served('gpt-y')).apiKey).toBe('deployment-key')
    }).pipe(Effect.provide(lane('8000', endpointFetch(['gpt-x', 'gpt-y', 'gpt-x'])))),
  )

  it.effect('keeps the deployment when the endpoint refuses the key, lists nothing or is not public https', () =>
    Effect.gen(function* () {
      const inference = yield* Inference
      const refused = yield* Effect.flip(inference.setOwner({ baseUrl: 'https://models.example', key: 'wrong' }, NOW))
      expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'model_key_refused' })
      const empty = yield* Effect.flip(inference.setOwner({ baseUrl: 'https://models.example', key: OWNER_KEY }, NOW))
      expect(empty).toMatchObject({ _tag: 'InvalidInput', reason: 'model_list_empty' })
      const plain = yield* Effect.flip(inference.setOwner({ baseUrl: 'http://models.example', key: OWNER_KEY }, NOW))
      expect(plain).toMatchObject({ _tag: 'InvalidInput' })
      expect(yield* inference.view).toEqual({ source: 'deployment', deployment: true, models: ['model-a'] })
    }).pipe(Effect.provide(lane(undefined, endpointFetch([])))),
  )
})

describe('a deployment without its own model endpoint (ADR 0064)', () => {
  it.effect('refuses every model call, offers nothing and caps nothing until the owner brings their own', () =>
    Effect.gen(function* () {
      const inference = yield* Inference
      const budget = yield* Budget
      const models = yield* Models
      expect(yield* inference.view).toEqual({ source: 'none', deployment: false, models: [] })
      expect(yield* Effect.flip(inference.served('model-a'))).toMatchObject({ _tag: 'NoModelEndpoint' })
      expect(yield* Effect.flip(budget.require(NOW))).toMatchObject({ _tag: 'NoModelEndpoint' })
      expect(yield* budget.today(NOW)).toMatchObject({ limit: null })
      expect(yield* models.choice).toEqual({ options: [] })
      expect(yield* Effect.flip(models.current)).toMatchObject({ _tag: 'NoModelEndpoint' })
      expect(yield* Effect.flip(models.choose('model-a', NOW))).toMatchObject({ _tag: 'NoModelEndpoint' })
      const view = yield* inference.setOwner({ baseUrl: 'https://models.example/v1', key: OWNER_KEY }, NOW)
      expect(view).toMatchObject({ source: 'owner', deployment: false, models: ['gpt-x'] })
      // Any id, the memory model's placeholder too, is sent as the owner's default; the cap does not hold for it.
      expect((yield* inference.served('default')).model).toBe('gpt-x')
      yield* budget.require(NOW)
      expect(yield* models.current).toBe('gpt-x')
      expect(yield* inference.clearOwner).toEqual({ source: 'none', deployment: false, models: [] })
      expect(yield* Effect.flip(budget.require(NOW))).toMatchObject({ _tag: 'NoModelEndpoint' })
    }).pipe(Effect.provide(lane('8000', endpointFetch(['gpt-x']), false))),
  )
})
