import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'
import { Internal, NotFound } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { makeBridge } from '../src/runtime/bridge.ts'

/** A bridge over a runtime with no services: the programs below read none of the agent's. */
const bridge = () => {
  // SAFETY: the programs below require no service, so an empty runtime stands in for the agent's.
  const runtime = ManagedRuntime.make(Layer.empty) as ManagedRuntime.ManagedRuntime<AgentServices, never>
  return makeBridge(async () => runtime)
}

describe('the bridge', () => {
  it('rejects with the typed failure the program failed with, the same object', async () => {
    const failure = new NotFound({ what: 'chat' })
    await expect(bridge().local(Effect.fail(failure))).rejects.toBe(failure)
  })

  it('rejects with Internal when the program dies', async () => {
    await expect(bridge().local(Effect.die(new RangeError('boom')))).rejects.toBeInstanceOf(Internal)
  })

  it('answers a runtime that failed to build as a failure, not a throw', async () => {
    const failing = makeBridge(async () => {
      throw new RangeError('start failed')
    })
    expect(Exit.isFailure(await failing.exit(Effect.succeed(1)))).toBe(true)
    await expect(failing.local(Effect.succeed(1))).rejects.toBeInstanceOf(Internal)
  })
})
