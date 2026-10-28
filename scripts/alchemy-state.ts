/**
 * Where a goblin stack keeps its Alchemy state. The deployed stages `dev` and `prod` share the account's Cloudflare
 * state store (the `alchemy-state-store` Worker, also used by myapps), so a deploy from any GitHub-hosted runner sees
 * the same records. Every other stage, and any stage under `alchemy dev`, keeps `<cwd>/.alchemy/state`.
 * Imported by `alchemy.run.ts` files only, never by Worker code.
 */
import * as Alchemy from 'alchemy'
import * as Cloudflare from '@alchemy.run/cloudflare'
import type { State } from 'alchemy/State'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

/** Whether a stage's state lives in the shared Cloudflare store: only a cloud run of `dev` or `prod`. */
export const usesRemoteState = (stage: string, dev: boolean): boolean => !dev && (stage === 'dev' || stage === 'prod')

/** Under `alchemy dev` the run is local, even for a stage named `dev`: its records must never reach the shared store. */
const isDev: Effect.Effect<boolean> = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(Alchemy.AlchemyContext)
  if (Option.isSome(context)) return context.value.dev
  return yield* Alchemy.ALCHEMY_DEV
}).pipe(Effect.orDie)

/** The stack's state store for this run: `Cloudflare.state()` for dev and prod, `Alchemy.localState()` otherwise. */
export const stackState = (): Layer.Layer<State, never, Alchemy.StackServices> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const remote = usesRemoteState(yield* Alchemy.Stage, yield* isDev)
      const layer: Layer.Layer<State, never, Alchemy.StackServices> = remote ? Cloudflare.state() : Alchemy.localState()
      return layer
    }),
  )
