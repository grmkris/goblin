import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'
import { Internal } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { topicContextExtension } from '../src/pi/topic-context.ts'
import { BACKGROUND } from '../src/pi/context.ts'
import { makeBridge } from '../src/runtime/bridge.ts'
import { CLOSED, type ScopeTopic } from '../src/setup/scope.ts'
import { Setups } from '../src/setup/service.ts'
import { topicContext } from '../src/topics/context.ts'
import { fake } from './fake.ts'
import { model, scriptedStreams, type SeenRequest } from './integration/model.ts'

describe('channel guidance generation hook', () => {
  it('aborts a request when guidance cannot be read and allows a later retry', async () => {
    const requests: SeenRequest[] = []
    let reads = 0
    let failRead = true
    const models = createModels()
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
        api: scriptedStreams((request) => {
          requests.push(request)
        }),
      }),
    )

    const travel = { id: 2, name: 'Travel', description: '', instructions: 'Use metric units.', holds: () => false }
    const services = Layer.succeed(
      Setups,
      fake<Setups['Service']>({
        scope: () =>
          Effect.suspend(() => {
            reads += 1
            return failRead
              ? Effect.die(new Internal({ reason: 'guidance unavailable', ref: 'guidance-fixture' }))
              : Effect.succeed({ ...CLOSED, topic: travel })
          }),
      }),
    )
    // SAFETY: topicContext reads only Setups, supplied by this test's real Effect layer.
    const runtime = ManagedRuntime.make(services) as ManagedRuntime.ManagedRuntime<AgentServices, never>
    const { run } = makeBridge(async () => runtime)
    let harness!: Harness
    const guidance = topicContextExtension(run, (task, context) => harness.abortTask(task, context))
    const registry = createRegistry()
    registry.install(guidance)
    harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, settings: { extensions: [guidance] } },
      BACKGROUND,
    )

    try {
      const root = await harness.root(BACKGROUND, {
        agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off' },
      })
      const failed = await root.submit(
        { type: 'input', content: 'failing guidance read', requestId: 'guidance-failure' },
        BACKGROUND,
      )
      const failedReceipt = await failed.wait(BACKGROUND)
      expect(failedReceipt.status).toBe('unanswered')
      if (failedReceipt.status === 'unanswered') expect(failedReceipt.reason).toBe('aborted')
      expect(requests).toHaveLength(0)
      expect(reads).toBe(1)

      failRead = false
      const healthy = await root.submit(
        { type: 'input', content: 'healthy guidance read', requestId: 'guidance-retry' },
        BACKGROUND,
      )
      const healthyReceipt = await healthy.wait(BACKGROUND)
      expect(healthyReceipt.status).toBe('done')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.context).toContain('Use metric units.')
      expect(reads).toBe(2)
    } finally {
      await harness.close(BACKGROUND)
      await runtime.dispose()
    }
  })
})

/** The context a chat in `topic` reads, in room `room` when it is one. */
const contextIn = (topic: ScopeTopic, room?: number) =>
  Effect.runPromise(
    topicContext('s').pipe(
      Effect.provideService(
        Setups,
        fake<Setups['Service']>({
          scope: () => Effect.succeed({ ...CLOSED, topic, ...(room === undefined ? {} : { room }) }),
        }),
      ),
    ),
  )

describe("a room's context (ADR 0108)", () => {
  const customer = { id: 7, name: 'Customer 7', description: '', instructions: 'Reply in German.', holds: () => false }

  it("always says the chat reaches only the room, and that its guidance is the server's and grants nothing", async () => {
    const room = await contextIn(customer, 7)
    expect(room).toContain('Channel: #Customer 7, a room.')
    expect(room).toContain('You reach only this room')
    expect(room).toContain("server's operator guidance")
    expect(room).toContain('Reply in German.')
    expect(await contextIn({ ...customer, instructions: '' }, 7)).toContain('You reach only this room')
    // Outside a room the owner's guidance reads as before, and none says nothing.
    expect(await contextIn(customer)).toContain('The owner configured this channel guidance')
    expect(await contextIn({ ...customer, instructions: '' })).toBeUndefined()
  })
})
