import type { ModelChoice, ModelOption } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { RuntimeEnv } from './env.ts'
import { type AppError, InvalidInput } from './http/errors.ts'
import { appModelChoice } from './storage/schema.ts'

/** The thinking levels goblin asks at, as Pi names them; `off` is the least thinking a model allows. */
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * How a model's thinking is bounded (ADR 0083). `budget`: a thinking token budget per level, and off turns thinking off
 * (Qwen on Model Studio, which then answers at once). `effort`: the provider's reasoning effort for each level, `null`
 * where it has none; with `switchesOff`, off turns thinking off instead of asking for the least effort.
 */
export type Thinking =
  | { readonly by: 'budget' }
  | {
      readonly by: 'effort'
      readonly switchesOff: boolean
      readonly efforts: Readonly<Partial<Record<ThinkingLevel, string | null>>>
    }

type Known = Omit<ModelOption, 'id' | 'contextWindow'> & { readonly thinking: Thinking }

/**
 * The context window Pi assumes for every offered model until a model's own is recorded here: it compacts the
 * conversation before this many tokens. The composer shows how full it is.
 */
const CONTEXT_WINDOW = 131_072

/** DeepSeek's efforts are low, high and max; medium and xhigh are its high and max (Model Studio, probed 2026-10-20). */
const DEEPSEEK: Thinking = {
  by: 'effort',
  switchesOff: true,
  efforts: { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
}

/**
 * The owner's own subscriptions, reached through CLIProxy (ADR 0087): no off switch, and their efforts run low to max
 * (Grok's to xhigh). Probed 2026-10-20: each calls tools and reads images.
 */
const SUBSCRIPTION: Thinking = {
  by: 'effort',
  switchesOff: false,
  efforts: { off: 'low', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
}

/** One of the owner's subscription models: their route, and they all see images. */
const subscription = (label: string, note: string, thinking: Thinking = SUBSCRIPTION): Known => ({
  label,
  route: 'Your subscription',
  note,
  images: true,
  thinking,
})

/**
 * What goblin knows about the models LiteLLM serves to it. Grouped by the route the call takes, because quotas are per
 * route: when Google refuses, an Alibaba model still answers. Probed 2026-10-04: every model here calls tools; `images`
 * is whether it reads image input (the others drop images silently). Thinking was probed on 2026-10-20: each value
 * here is one the endpoint accepts.
 */
const KNOWN: Readonly<Record<string, Known>> = {
  // Thinking cannot be turned off; its levels are low, medium and high.
  'gemini-3.8-flash': {
    label: 'Gemini 3.8 Flash',
    route: 'Google',
    note: 'Fast, sees images',
    images: true,
    thinking: {
      by: 'effort',
      switchesOff: false,
      efforts: { off: 'low', minimal: null, low: 'low', medium: 'medium', high: 'high' },
    },
  },
  'qwen3.8-flash': {
    label: 'Qwen 3.8 Flash',
    route: 'Alibaba Cloud',
    note: 'Fast, sees images',
    images: true,
    thinking: { by: 'budget' },
  },
  'qwen3.8-max': {
    label: 'Qwen 3.8 Max',
    route: 'Alibaba Cloud',
    note: 'Larger, sees images',
    images: true,
    thinking: { by: 'budget' },
  },
  // Thinking cannot be turned off, and Model Studio ignores a budget for it: its efforts are low, high and max.
  'glm-5.3': {
    label: 'GLM 5.3',
    route: 'Alibaba Cloud',
    note: 'Thinks at length, text only',
    images: false,
    thinking: {
      by: 'effort',
      switchesOff: false,
      efforts: { off: 'low', minimal: null, low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
    },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    route: 'Alibaba Cloud',
    note: 'Larger, text only',
    images: false,
    thinking: DEEPSEEK,
  },
  // Probed 2026-10-12 on the Token Plan: calls tools.
  'deepseek-v4.1-flash': {
    label: 'DeepSeek V4.1 Flash',
    route: 'Alibaba Cloud',
    note: 'Fast, text only',
    images: false,
    thinking: DEEPSEEK,
  },
  // Thinking cannot be turned off (`none` is refused); minimal is its least.
  'muse-spark-1.3-contributor': {
    label: 'Muse Spark 1.3',
    route: 'Meta',
    note: 'Text only',
    images: false,
    thinking: {
      by: 'effort',
      switchesOff: false,
      efforts: {
        off: 'minimal',
        minimal: 'minimal',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    },
  },
  'sub/claude-fable-5-1': subscription('Claude Fable 5.1', 'Largest, sees images'),
  'sub/claude-opus-5-5': subscription('Claude Opus 5.5', 'Larger, sees images'),
  'sub/claude-sonnet-5-5': subscription('Claude Sonnet 5.5', 'Fast, sees images'),
  'sub/gpt-6.1-sol': subscription('GPT-6.1 Sol', 'Sees images'),
  'sub/gpt-6-astra': subscription('GPT-6 Astra', 'Sees images'),
  'sub/grok-4.7': subscription('Grok 4.7', 'Sees images', {
    ...SUBSCRIPTION,
    efforts: { ...SUBSCRIPTION.efforts, max: null },
  }),
}

/** How goblin bounds model `id`'s thinking, or nothing for a model it does not know, which is sent no thinking control. */
export const thinkingOf = (id: string): Thinking | undefined => KNOWN[id]?.thinking

/** Never empty: the default model is always offered, first. */
export type ModelOptions = readonly [ModelOption, ...ModelOption[]]

/** What the picker says about model `id`: what goblin knows of it, else its own name, text only. */
export const optionOf = (id: string): ModelOption => {
  const known = KNOWN[id]
  if (known === undefined)
    return { id, label: id, route: 'Other', note: '', images: false, contextWindow: CONTEXT_WINDOW }
  const { label, route, note, images } = known
  return { id, label, route, note, images, contextWindow: CONTEXT_WINDOW }
}

/** The model names in a comma-separated list, as `MODELS` and `OWNER_MODELS` give them. */
const namesIn = (list: string | undefined): readonly string[] =>
  (list ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')

/**
 * The models this deployment offers: `MODELS` (comma-separated model names) with the default `MODEL_ID` always
 * first. An unknown name is offered under its own name, text only.
 */
export function modelOptions(models: string | undefined, defaultId: string): ModelOptions {
  const others = [...new Set(namesIn(models))].filter((id) => id !== defaultId)
  return [optionOf(defaultId), ...others.map(optionOf)]
}

/** The deployment's own model endpoint: where its calls go, its key, and the models it offers, its default first. */
export type DeploymentEndpoint = { readonly baseUrl: string; readonly apiKey: string; readonly options: ModelOptions }

type DeploymentEnvironment = Partial<
  Pick<RuntimeEnv, 'MODEL_BASE_URL' | 'MODEL_ID' | 'MODEL_KEY' | 'MODELS' | 'OWNER_WORKSPACE_ID' | 'OWNER_MODELS'>
>

/**
 * The deployment's model endpoint (ADR 0064): `MODEL_BASE_URL`, `MODEL_KEY` and the default `MODEL_ID`, all three set.
 * Without any one of them the deployment has no endpoint, and each owner brings their own (ADR 0059).
 */
export function deploymentEndpoint(env: DeploymentEnvironment): DeploymentEndpoint | undefined {
  const baseUrl = env.MODEL_BASE_URL?.trim() ?? ''
  const defaultId = env.MODEL_ID?.trim() ?? ''
  const apiKey = env.MODEL_KEY ?? ''
  if (baseUrl === '' || defaultId === '' || apiKey === '') return undefined
  return { baseUrl, apiKey, options: modelOptions(env.MODELS, defaultId) }
}

/**
 * The models on the deployment owner's own subscriptions (`OWNER_MODELS`, ADR 0087). Every account's models never
 * count among them, so naming one in both lists offers it to everyone.
 */
export const ownerModelIds = (env: DeploymentEnvironment): readonly string[] => {
  const everyone = new Set([env.MODEL_ID?.trim() ?? '', ...namesIn(env.MODELS)])
  return namesIn(env.OWNER_MODELS).filter((id) => !everyone.has(id))
}

/**
 * Whether workspace `workspaceId` is offered the deployment owner's own subscriptions: it is the owner's own
 * (`OWNER_WORKSPACE_ID`, ADRs 0087, 0089) and the deployment has an endpoint and subscriptions to offer. Such a
 * workspace takes no other members (ADR 0095).
 */
export const offersOwnerModels = (env: DeploymentEnvironment, workspaceId: string): boolean => {
  const owner = env.OWNER_WORKSPACE_ID?.trim() ?? ''
  return owner !== '' && workspaceId === owner && deploymentEndpoint(env) !== undefined && ownerModelIds(env).length > 0
}

/**
 * The deployment's endpoint as workspace `workspaceId` is offered it (ADRs 0087, 0089): every workspace's models, and
 * in the deployment owner's own workspace alone also their subscriptions (`offersOwnerModels`), after the others.
 */
export function offeredEndpoint(env: DeploymentEnvironment, workspaceId: string): DeploymentEndpoint | undefined {
  const shared = deploymentEndpoint(env)
  if (shared === undefined || !offersOwnerModels(env, workspaceId)) return shared
  const [first, ...rest] = shared.options
  return { ...shared, options: [first, ...rest, ...ownerModelIds(env).map(optionOf)] }
}

/**
 * The ids of the models the deployment offers workspace `workspaceId`, its default first; none without its own
 * endpoint.
 */
export const deploymentModelIds = (env: DeploymentEnvironment, workspaceId: string): readonly string[] =>
  offeredEndpoint(env, workspaceId)?.options.map((option) => option.id) ?? []

/**
 * The model id a call names when the deployment offers none: whatever endpoint answers it serves its own default in
 * its place (`Inference.served`), as it does for any id it does not serve.
 */
export const ENDPOINT_DEFAULT = 'default'

/**
 * The model that names threads and writes main's memory: `GOBLIN_MEMORY_MODEL` when offered, else the deployment's
 * default, else (no deployment models) the default of the endpoint in use.
 */
export function memoryModelId(memoryModel: string | undefined, offered: readonly string[]): string {
  return offered.find((id) => id === memoryModel) ?? offered[0] ?? ENDPOINT_DEFAULT
}

/** The user's stored pick (one row), if any. */
export interface ChoiceLedger {
  get(): string | undefined
  set(modelId: string, now: number): void
}

export class ModelChoiceStore implements ChoiceLedger {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  get(): string | undefined {
    return this.#db.select().from(appModelChoice).where(eq(appModelChoice.id, 1)).get()?.modelId
  }

  set(modelId: string, now: number): void {
    this.#db
      .insert(appModelChoice)
      .values({ id: 1, modelId, updatedAt: now })
      .onConflictDoUpdate({ target: appModelChoice.id, set: { modelId, updatedAt: now } })
      .run()
  }
}

/**
 * The model this user's agent answers with, among `options` (the endpoint's, its default first). A stored pick the
 * endpoint no longer offers falls back to the default, so a model that goes never strands anyone.
 */
export class ModelPicker {
  readonly #ledger: ChoiceLedger
  readonly #options: ModelOptions
  constructor(ledger: ChoiceLedger, options: ModelOptions) {
    this.#ledger = ledger
    this.#options = options
  }

  current(): string {
    const chosen = this.#ledger.get()
    return chosen !== undefined && this.#options.some((option) => option.id === chosen) ? chosen : this.#options[0].id
  }

  /** The endpoint's default, which every account is offered. */
  defaultId(): string {
    return this.#options[0].id
  }

  choice(): ModelChoice {
    return { current: this.current(), default: this.defaultId(), options: this.#options }
  }

  /** Fails with `InvalidInput` for a model the endpoint does not offer. */
  choose(modelId: string, now: number): ModelChoice {
    if (!this.#options.some((option) => option.id === modelId)) throw new InvalidInput({ reason: 'model' })
    this.#ledger.set(modelId, now)
    return this.choice()
  }
}

/**
 * The model the owner's agent answers with, and the owner's pick among those its model endpoint offers. Without a model
 * endpoint (ADR 0064) nothing is offered: `current` and `choose` fail with `NoModelEndpoint`.
 */
export class Models extends Context.Service<
  Models,
  {
    /** The pick when the endpoint still offers it, else the default. */
    readonly current: Effect.Effect<string, AppError>
    readonly choice: Effect.Effect<ModelChoice, AppError>
    /** Stores the pick (epoch seconds); `InvalidInput` for a model the endpoint does not offer. */
    readonly choose: (modelId: string, now: number) => Effect.Effect<ModelChoice, AppError>
    /** Whether `id` is one of the owner's own subscriptions (`ownerModelIds`, ADR 0087), which a server's work never uses. */
    readonly ownerOnly: (id: string) => boolean
    /** The model a server's work answers with (ADR 0087): the pick, unless it is one of the owner's own, then the default. */
    readonly forServers: Effect.Effect<string, AppError>
    /** The choice as a server's key reads it (ADR 0087): without the owner's own subscriptions. */
    readonly choiceForServers: Effect.Effect<ModelChoice, AppError>
  }
>()('goblin/models/Models') {}
