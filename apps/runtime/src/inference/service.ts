import type { ModelEndpointView } from '@goblin/contracts'
import { ERROR_COPY } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import { type AppError, NoModelEndpoint } from '../http/errors.ts'

/** Where a model call goes, and what it may ask for there: the owner's own endpoint, else the deployment's. */
export type ResolvedEndpoint = {
  readonly source: 'owner' | 'deployment'
  readonly baseUrl: string
  readonly apiKey: string
  /** The model ids the endpoint serves, its default first. */
  readonly models: readonly [string, ...string[]]
}

/**
 * The endpoint in use, or `none` (ADR 0064): the deployment has no endpoint of its own and the owner has not set
 * theirs, so every model call is refused with `NoModelEndpoint` until they do.
 */
export type CurrentEndpoint = ResolvedEndpoint | { readonly source: 'none' }

/** One model call's way out: the endpoint, its key, and a model it serves (the one asked for, else its default). */
export type ServedModel = { readonly baseUrl: string; readonly apiKey: string; readonly model: string }

/**
 * The owner's choice of model endpoint (ADR 0059): their own OpenAI-compatible endpoint and key, or the deployment's
 * when it has one (ADR 0064).
 */
export class Inference extends Context.Service<
  Inference,
  {
    /** The endpoint model calls go to now, or `none`. */
    readonly endpoint: Effect.Effect<CurrentEndpoint, AppError>
    /**
     * One call's way out for model `modelId`: an id the endpoint does not serve becomes its default. `NoModelEndpoint`
     * when there is no endpoint.
     */
    readonly served: (modelId: string) => Effect.Effect<ServedModel, AppError>
    /** The endpoint as the owner sees it: never a key, only its last characters. */
    readonly view: Effect.Effect<ModelEndpointView, AppError>
    /** Sets the owner's endpoint once it lists its models with `key` (epoch seconds); `InvalidInput` otherwise. */
    readonly setOwner: (
      input: { readonly baseUrl: string; readonly key: string },
      now: number,
    ) => Effect.Effect<ModelEndpointView, AppError>
    /** Goes back to the deployment's endpoint, or to none when the deployment has no endpoint. */
    readonly clearOwner: Effect.Effect<ModelEndpointView, AppError>
  }
>()('goblin/inference/Inference') {}

/**
 * The words a model call that found no endpoint ends with in its conversation: the failure's own copy, which the web
 * shows as the notice to bring a model key (`apps/web/src/lib/chat-messages.ts`).
 */
export const NO_ENDPOINT_ANSWER = `${ERROR_COPY.NoModelEndpoint.message} ${ERROR_COPY.NoModelEndpoint.recovery}`

/**
 * A failure of `served` as Pi's provider takes it: a `NoModelEndpoint` (whose message is empty) becomes an error that
 * says so, since Pi ends the response with the error's message; any other failure stays as it was.
 */
export const servedFailure = (cause: unknown): Error =>
  cause instanceof NoModelEndpoint
    ? new Error(NO_ENDPOINT_ANSWER)
    : cause instanceof Error
      ? cause
      : new Error('model endpoint unreadable', { cause })
