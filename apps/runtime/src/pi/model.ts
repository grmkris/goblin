import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { lazyStream } from '@earendil-works/pi-ai/api/lazy'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai/utils/event-stream'
import type { Api, AssistantMessage, Model, ProviderStreams, Usage } from '@earendil-works/pi-ai'
import type { ModelOption } from '@goblin/contracts'
import { RunAttribute } from '@goblin/contracts/telemetry'
import type { RuntimeEnv } from '../env.ts'
import {
  ENDPOINT_DEFAULT,
  type ModelOptions,
  type Thinking,
  deploymentEndpoint,
  optionOf,
  thinkingOf,
} from '../models.ts'

type ModelEnvironment = Partial<Pick<RuntimeEnv, 'MODEL_ID' | 'MODEL_BASE_URL' | 'MODEL_KEY' | 'MODELS'>>

/** Every model is served under one provider id, whichever endpoint answers it; `session.setModel` names it. */
export const MODEL_PROVIDER = 'goblin-litellm'

/**
 * The most a model writes in one response. pi-ai sends it on every request (clamped to what the context leaves). It is
 * a ceiling, not how thinking is bounded: for some models (DeepSeek and GLM on Model Studio) thinking shares it with
 * the answer, so each model's own thinking control keeps thinking well below it (`thinkingFields`). A response cut here
 * ends with `stopReason: 'length'`, which the owner sees.
 */
export const MAX_OUTPUT_TOKENS = 32_768

type ThinkingFields = Pick<Model<'openai-completions'>, 'reasoning' | 'compat' | 'thinkingLevelMap'>

/**
 * A model's thinking as pi-ai sends it (ADR 0083): the level Pi asks at bounded by the model's own control, a thinking
 * token budget (`thinking_budget`, under which Model Studio answers once it is spent) or a reasoning effort per level.
 * Asking at no level asks for the least: thinking switched off (`enable_thinking`) where the model allows it, its
 * least effort where it does not. A model goblin does not know is sent no thinking control.
 */
const thinkingFields = (thinking: Thinking | undefined): ThinkingFields => {
  if (thinking === undefined) return { reasoning: false }
  if (thinking.by === 'budget')
    return {
      reasoning: true,
      compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false, thinkingTokenBudgetField: 'thinking_budget' },
    }
  return {
    reasoning: true,
    compat: thinking.switchesOff
      ? { thinkingFormat: 'qwen', supportsReasoningEffort: true }
      : { supportsReasoningEffort: true },
    thinkingLevelMap: thinking.efforts,
  }
}

/** The provider is configured at the Worker boundary; its key never enters Pi state. */
function makePiModel(
  option: ModelOption,
  baseUrl: string,
  contextWindow?: number,
  provider = MODEL_PROVIDER,
): Model<'openai-completions'> {
  return {
    id: option.id,
    name: option.label,
    provider,
    api: 'openai-completions',
    baseUrl,
    input: option.images ? ['text', 'image'] : ['text'],
    ...thinkingFields(thinkingOf(option.id)),
    contextWindow: contextWindow ?? option.contextWindow,
    maxTokens: MAX_OUTPUT_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/**
 * The least room an answer is sent with. pi-ai clamps the output limit to what the context leaves, down to one token,
 * and a reasoning model spends a small limit thinking: glm-5.3 on a full Personal chat answered one token, cut off,
 * which Pi does not take for a full context. Below this the request is not sent: it fails as a context overflow, so
 * Pi compacts the conversation and tries once more.
 */
export const MIN_ANSWER_ROOM = 4096

/** A response of `model` that failed with `text` before any tokens were spent. */
const failed = (model: Model<Api>, text: string): AssistantMessage => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: 'error',
    errorMessage: text,
    timestamp: Date.now(),
  }
}

/** Ends `events` with `message`: the event its stop reason calls for (a deferred one has none), then the result. */
const settle = (events: AssistantMessageEventStream, message: AssistantMessage): void => {
  const { stopReason } = message
  if (stopReason === 'error' || stopReason === 'aborted')
    events.push({ type: 'error', reason: stopReason, error: message })
  else if (stopReason !== 'pending') events.push({ type: 'done', reason: stopReason, message })
  events.end(message)
}

/** A response that never reached the provider: the context leaves too little room for an answer. */
function tooFull(model: Model<'openai-completions'>, room: number) {
  const events = createAssistantMessageEventStream()
  // Worded to match pi-ai's overflow patterns ("exceeds the context window"), which start Pi's compaction.
  settle(
    events,
    failed(model, `The conversation exceeds the context window: ${String(room)} tokens left for the answer.`),
  )
  return events
}

/** Recovery's nudge (ADR 0083), after Gemini CLI's: the response ended without an answer. */
const ANSWER_NOW =
  'Your last response ended without an answer. Give your final answer now, or call a tool, without thinking at length.'

/**
 * How a response ends when its model ended without answering, also when asked again (ADR 0083): goblin's own words,
 * which Pi does not take for a passing provider failure, and a Persona's answer flow reads as no answer.
 */
export const NO_ANSWER = 'The model gave no answer, also when asked again.'

/**
 * A response that ended without an answer or a tool call: it thought until its output limit, or said nothing (Muse
 * ends a thought cut off that way, with `stop`).
 */
const unanswered = (message: AssistantMessage): boolean =>
  (message.stopReason === 'length' || message.stopReason === 'stop') &&
  !message.content.some((block) => block.type === 'toolCall' || (block.type === 'text' && block.text.trim() !== ''))

/** The tokens of two responses to one request, both spent. */
const together = (first: Usage, second: Usage): Usage => ({
  input: first.input + second.input,
  output: first.output + second.output,
  cacheRead: first.cacheRead + second.cacheRead,
  cacheWrite: first.cacheWrite + second.cacheWrite,
  ...(first.reasoning === undefined && second.reasoning === undefined
    ? {}
    : { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }),
  totalTokens: first.totalTokens + second.totalTokens,
  cost: {
    input: first.cost.input + second.cost.input,
    output: first.cost.output + second.cost.output,
    cacheRead: first.cost.cacheRead + second.cost.cacheRead,
    cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
    total: first.cost.total + second.cost.total,
  },
})

/** Passes `from`'s events on to `to`, all but the one that ends it, and answers its final message. */
async function relay(from: AssistantMessageEventStream, to: AssistantMessageEventStream): Promise<AssistantMessage> {
  for await (const event of from) if (event.type !== 'done' && event.type !== 'error') to.push(event)
  return from.result()
}

/**
 * A request that answers (ADR 0083). When the response ends without an answer, the request is sent once more at no
 * thinking level, which asks for the least thinking its model allows (`thinkingFields`), with a nudge to answer now.
 * That reply is the response, its tokens counted with the first's and a diagnostic the run ledger records
 * (`goblin.recovered`). When it ends without an answer too, the response fails with `NO_ANSWER`, marked as cut off or
 * empty. The live partials of both go on to Pi as they come.
 */
async function answer(
  streams: ProviderStreams,
  out: AssistantMessageEventStream,
  ...[model, context, options]: Parameters<ProviderStreams['streamSimple']>
): Promise<AssistantMessage> {
  const first = await relay(streams.streamSimple(model, context, options), out)
  if (!unanswered(first)) return first
  const { reasoning: _asked, ...least } = options ?? {}
  const asked = {
    ...context,
    messages: [...context.messages, { role: 'user' as const, content: ANSWER_NOW, timestamp: Date.now() }],
  }
  const second = await relay(streams.streamSimple(model, asked, least), out)
  const usage = together(first.usage, second.usage)
  const noting = (type: string) => [...(second.diagnostics ?? []), { type, timestamp: Date.now() }]
  if (unanswered(second))
    return {
      ...second,
      content: [],
      usage,
      stopReason: 'error',
      errorMessage: NO_ANSWER,
      diagnostics: noting(second.stopReason === 'length' ? RunAttribute.cutoff : RunAttribute.emptyAnswer),
    }
  return { ...second, usage, diagnostics: noting(RunAttribute.recovered) }
}

/** `streams` whose every simple request answers (`answer`); its full requests go out as they are. */
export const answering = (streams: ProviderStreams): ProviderStreams => ({
  stream: (model, context, options) => streams.stream(model, context, options),
  streamSimple: (model, context, options) => {
    const out = createAssistantMessageEventStream()
    answer(streams, out, model, context, options).then(
      (message) => settle(out, message),
      (error: unknown) => settle(out, failed(model, error instanceof Error ? error.message : String(error))),
    )
    return out
  },
})

/** The provider and model Pi runs for a model id: goblin's model provider, whichever endpoint answers it. */
export const modelRef = (id: string): { readonly provider: string; readonly id: string } => ({
  provider: MODEL_PROVIDER,
  id,
})

/**
 * How every model's requests leave: an OpenAI-compatible chat completions API, never with a starved answer, and every
 * simple request answering rather than only thinking (`answering`).
 */
export const LITELLM_STREAMS: ProviderStreams = answering({
  stream,
  streamSimple: (model, context, options) => {
    const wanted = options?.maxTokens ?? model.maxTokens
    const room = clampMaxTokensToContext(model, context, wanted)
    // SAFETY: goblin's provider serves only openai-completions models (makePiModel).
    const target = model as Model<'openai-completions'>
    return room < Math.min(MIN_ANSWER_ROOM, wanted) ? tooFull(target, room) : streamSimple(target, context, options)
  },
})

/** One call's way out (`inference/service.ts` `served`): the endpoint, its key and a model it serves. */
export type ResolveModel = (modelId: string) => Promise<{ baseUrl: string; apiKey: string; model: string }>

/**
 * `streams` with each call sent where `resolve` says, at the moment it is made (ADR 0059): to the owner's own endpoint
 * with its key, else the deployment's, and with a model that endpoint serves. A call whose endpoint cannot be read ends
 * as a failed response.
 */
const resolving = (streams: ProviderStreams, resolve: ResolveModel): ProviderStreams => ({
  stream: (model, context, options) =>
    lazyStream(model, async () => {
      const served = await resolve(model.id)
      return streams.stream({ ...model, id: served.model, baseUrl: served.baseUrl }, context, {
        ...options,
        apiKey: served.apiKey,
      })
    }),
  streamSimple: (model, context, options) =>
    lazyStream(model, async () => {
      const served = await resolve(model.id)
      return streams.streamSimple({ ...model, id: served.model, baseUrl: served.baseUrl }, context, {
        ...options,
        apiKey: served.apiKey,
      })
    }),
})

/** A routine run's own provider id (`pi/routine-run.ts`): its calls check the routine's authority first. */
const ROUTINE_PROVIDER = /^goblin-routine:(rr_[\w-]{1,100})$/u

/**
 * Every offered model (`models.ts`), the default first; `model` is the default for new sessions. `streams` carries
 * the requests; only a test passes anything but LiteLLM's. With `resolve`, each call goes to the endpoint it names, and
 * any model id is a model of goblin's provider, which that endpoint answers with one it serves. A deployment without
 * its own endpoint (ADR 0064) offers one placeholder, `ENDPOINT_DEFAULT`, which the owner's endpoint answers with its
 * default; until they set one, `resolve` refuses every call.
 */
export function makePiModels(
  env: ModelEnvironment,
  streams: ProviderStreams = LITELLM_STREAMS,
  contextWindow?: number,
  authorizeRoutine?: (runId: string) => Promise<void>,
  resolve?: ResolveModel,
) {
  const deployment = deploymentEndpoint(env)
  const options: ModelOptions = deployment?.options ?? [optionOf(ENDPOINT_DEFAULT)]
  const baseUrl = deployment?.baseUrl ?? ''
  const apiKey = deployment?.apiKey ?? ''
  const [first, ...rest] = options
  const model = makePiModel(first, baseUrl, contextWindow)
  const others = rest.map((option) => makePiModel(option, baseUrl, contextWindow))
  const models = createModels()
  const api = resolve === undefined ? streams : resolving(streams, resolve)
  const provider = createProvider({
    id: MODEL_PROVIDER,
    name: 'goblin model endpoint',
    baseUrl,
    models: [model, ...others],
    auth: {
      apiKey: {
        name: 'goblin model key',
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    api,
  })
  models.setProvider(provider)
  if (resolve !== undefined) {
    // The owner's endpoint serves models the deployment does not offer: any id is a model of goblin's provider (and of
    // a routine's), sent with one the endpoint serves.
    const listed = models.getModel.bind(models)
    models.getModel = (providerId, id) =>
      listed(providerId, id) ??
      (providerId === MODEL_PROVIDER || ROUTINE_PROVIDER.test(providerId)
        ? makePiModel(optionOf(id), baseUrl, contextWindow, providerId)
        : undefined)
  }
  if (authorizeRoutine !== undefined) {
    const original = models.getModel.bind(models)
    models.getModel = (providerId, id) => {
      const runId = ROUTINE_PROVIDER.exec(providerId)?.[1]
      if (runId !== undefined && models.getProvider(providerId) === undefined) {
        models.setProvider(
          createProvider({
            id: providerId,
            name: 'goblin routine',
            baseUrl,
            models: options.map((option) => makePiModel(option, baseUrl, contextWindow, providerId)),
            auth: {
              apiKey: {
                name: 'Routine model authority',
                resolve: async () => {
                  await authorizeRoutine(runId)
                  return { auth: { apiKey } }
                },
              },
            },
            api,
          }),
        )
      }
      return original(providerId, id)
    }
  }
  return { models, model, options }
}
