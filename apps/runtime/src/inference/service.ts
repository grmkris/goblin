import type { ModelEndpointView } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'

/** Where a model call goes, and what it may ask for there: the owner's own endpoint, else the deployment's. */
export type ResolvedEndpoint = {
  readonly source: 'owner' | 'deployment'
  readonly baseUrl: string
  readonly apiKey: string
  /** The model ids the endpoint serves, its default first. */
  readonly models: readonly [string, ...string[]]
}

/** One model call's way out: the endpoint, its key, and a model it serves (the one asked for, else its default). */
export type ServedModel = { readonly baseUrl: string; readonly apiKey: string; readonly model: string }

/** The owner's choice of model endpoint (ADR 0059): their own OpenAI-compatible endpoint and key, or the deployment's. */
export class Inference extends Context.Service<
  Inference,
  {
    /** The endpoint model calls go to now. */
    readonly endpoint: Effect.Effect<ResolvedEndpoint, AppError>
    /** One call's way out for model `modelId`: an id the endpoint does not serve becomes its default. */
    readonly served: (modelId: string) => Effect.Effect<ServedModel, AppError>
    /** The endpoint as the owner sees it: never a key, only its last characters. */
    readonly view: Effect.Effect<ModelEndpointView, AppError>
    /** Sets the owner's endpoint once it lists its models with `key` (epoch seconds); `InvalidInput` otherwise. */
    readonly setOwner: (
      input: { readonly baseUrl: string; readonly key: string },
      now: number,
    ) => Effect.Effect<ModelEndpointView, AppError>
    /** Goes back to the deployment's endpoint. */
    readonly clearOwner: Effect.Effect<ModelEndpointView, AppError>
  }
>()('goblin/inference/Inference') {}
