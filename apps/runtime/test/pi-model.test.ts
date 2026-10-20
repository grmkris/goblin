import type { AssistantMessage, Message, Model, ProviderStreams, ThinkingLevel } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { describe, expect, it } from 'vitest'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { NoModelEndpoint } from '../src/http/errors.ts'
import { NO_ENDPOINT_ANSWER, servedFailure } from '../src/inference/service.ts'
import { LITELLM_STREAMS, MAX_OUTPUT_TOKENS, MIN_ANSWER_ROOM, MODEL_PROVIDER, makePiModels } from '../src/pi/model.ts'

const env = {
  MODEL_ID: 'qwen3.8-flash',
  MODELS: 'deepseek-v4.1-flash,deepseek-v4-pro,glm-5.3,gemini-3.8-flash,muse-spark-1.3-contributor,unknown-model',
  MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
  MODEL_KEY: 'test',
}

/** The chat completions request pi-ai would send for `messages` to model `id` at `reasoning`, captured before it leaves. */
async function requestFor(messages: Message[], id = env.MODEL_ID, reasoning?: ThinkingLevel) {
  const model = makePiModels(env).models.getModel(MODEL_PROVIDER, id)
  if (model === undefined) throw new Error(`not offered: ${id}`)
  let request: Record<string, unknown> = {}
  const stream = LITELLM_STREAMS.streamSimple(model, normalizeContext({ systemPrompt: 'Be brief.', messages }), {
    apiKey: 'test',
    ...(reasoning === undefined ? {} : { reasoning }),
    onPayload: (params) => {
      // SAFETY: openai-completions hands over the JSON object it is about to send.
      request = params as Record<string, unknown>
      throw new Error('captured')
    },
  })
  const result = await stream.result()
  return { request, result }
}

const ask = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 })

describe('the output limit (unit)', () => {
  it('lets every answer run to 32K tokens', async () => {
    expect(MAX_OUTPUT_TOKENS).toBe(32_768)
    expect((await requestFor([ask('hi')])).request).toMatchObject({ max_completion_tokens: MAX_OUTPUT_TOKENS })
  })

  it('leaves the answer only what the context window has left', async () => {
    const { request } = await requestFor([ask('word '.repeat(80_000))])
    expect(request.max_completion_tokens).toBeLessThan(MAX_OUTPUT_TOKENS)
    expect(request.max_completion_tokens).toBeGreaterThanOrEqual(MIN_ANSWER_ROOM)
  })

  it('sends nothing when too little is left for an answer, and fails as an overflow so Pi compacts', async () => {
    const { request, result } = await requestFor([ask('word '.repeat(400_000))])
    expect(request).toEqual({})
    expect(result).toMatchObject({ stopReason: 'error', model: 'qwen3.8-flash' })
    expect(isContextOverflow(result)).toBe(true)
  })
})

/** The thinking controls a request carries. */
const thinkingParams = (request: Record<string, unknown>) =>
  Object.fromEntries(
    ['enable_thinking', 'thinking_budget', 'reasoning_effort'].flatMap((key) =>
      key in request ? [[key, request[key]]] : [],
    ),
  )

describe('how thinking is bounded (unit)', () => {
  // Each value is one the deployment's endpoint accepted for that model (probed 2026-10-20).
  it.each([
    ['qwen3.8-flash', 'medium', { enable_thinking: true, thinking_budget: 8192 }],
    ['qwen3.8-flash', undefined, { enable_thinking: false }],
    ['deepseek-v4.1-flash', 'medium', { enable_thinking: true, reasoning_effort: 'high' }],
    ['deepseek-v4.1-flash', undefined, { enable_thinking: false }],
    ['deepseek-v4-pro', 'minimal', { enable_thinking: true, reasoning_effort: 'low' }],
    ['glm-5.3', 'medium', { reasoning_effort: 'high' }],
    ['glm-5.3', undefined, { reasoning_effort: 'low' }],
    ['gemini-3.8-flash', 'medium', { reasoning_effort: 'medium' }],
    ['gemini-3.8-flash', undefined, { reasoning_effort: 'low' }],
    ['muse-spark-1.3-contributor', 'medium', { reasoning_effort: 'medium' }],
    ['muse-spark-1.3-contributor', undefined, { reasoning_effort: 'minimal' }],
    ['unknown-model', 'medium', {}],
  ] as const)('sends %s at %s level: %j', async (id, level, sent) => {
    expect(thinkingParams((await requestFor([ask('hi')], id, level)).request)).toEqual(sent)
  })
})

/** Streams that record what each request was sent with and answer an empty message. */
const recording = () => {
  const sent: { id: string; baseUrl: string; apiKey: string | undefined }[] = []
  const answer: ProviderStreams['streamSimple'] = (model, _context, options) => {
    sent.push({ id: model.id, baseUrl: model.baseUrl, apiKey: options?.apiKey })
    const events = createAssistantMessageEventStream()
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
      stopReason: 'stop',
      timestamp: 1,
    }
    events.push({ type: 'done', reason: 'stop', message })
    events.end()
    return events
  }
  return { sent, streams: { stream: answer, streamSimple: answer } }
}

describe('the model endpoint each call goes to (unit)', () => {
  const context = normalizeContext({ systemPrompt: 'Be brief.', messages: [ask('hi')] })

  it('sends each call to the endpoint resolved for it, with its key and a model it serves, for any model id', async () => {
    const { sent, streams } = recording()
    const { models } = makePiModels(env, streams, undefined, undefined, async (id) => ({
      baseUrl: 'https://models.example/v1',
      apiKey: 'own-key',
      model: id === 'own-model' ? id : 'own-default',
    }))
    const own = models.getModel(MODEL_PROVIDER, 'own-model')
    const listed = models.getModel(MODEL_PROVIDER, 'qwen3.8-flash')
    expect(own).toMatchObject({ id: 'own-model', provider: MODEL_PROVIDER })
    expect(models.getModel('another-provider', 'own-model')).toBeUndefined()
    // SAFETY: both ids resolve above.
    for (const model of [own, listed] as Model<'openai-completions'>[])
      await models.streamSimple(model, context).result()
    expect(sent).toEqual([
      { id: 'own-model', baseUrl: 'https://models.example/v1', apiKey: 'own-key' },
      { id: 'own-default', baseUrl: 'https://models.example/v1', apiKey: 'own-key' },
    ])
  })

  it('ends a call whose endpoint cannot be read as a failed response, sending nothing', async () => {
    const { sent, streams } = recording()
    const { models, model } = makePiModels(env, streams, undefined, undefined, async () => {
      throw new Error('no endpoint')
    })
    expect(await models.streamSimple(model, context).result()).toMatchObject({ stopReason: 'error' })
    expect(sent).toEqual([])
  })

  it("offers a placeholder default without the deployment's own endpoint, answered by the owner's", async () => {
    const { sent, streams } = recording()
    const { models, model, options } = makePiModels({}, streams, undefined, undefined, async () => ({
      baseUrl: 'https://models.example/v1',
      apiKey: 'own-key',
      model: 'own-default',
    }))
    expect(options.map((option) => option.id)).toEqual(['default'])
    expect(models.getModel(MODEL_PROVIDER, 'default')).toMatchObject({ id: 'default' })
    await models.streamSimple(model, context).result()
    expect(sent).toEqual([{ id: 'own-default', baseUrl: 'https://models.example/v1', apiKey: 'own-key' }])
  })

  it('ends every call with the refusal in its own words while no endpoint is set', async () => {
    const { sent, streams } = recording()
    const { models, model } = makePiModels({}, streams, undefined, undefined, async () => {
      throw servedFailure(new NoModelEndpoint({}))
    })
    expect(await models.streamSimple(model, context).result()).toMatchObject({
      stopReason: 'error',
      errorMessage: NO_ENDPOINT_ANSWER,
    })
    expect(sent).toEqual([])
  })
})
