import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Config, ConfigProvider, Effect } from 'effect'
import { decisionsCase } from './native-decisions.ts'
import Stack from './stack.ts'

// The native stack on its own port: the decisions probe needs the native agent's scripted model and fake Clef, and
// native.test.ts is at its size limit.
const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_native_decisions',
  dev: true,
})
const stack = harness.beforeAll(
  Effect.gen(function* () {
    const port = yield* Config.Port('GOBLIN_HARNESS_PORT')
    return yield* harness
      .deploy(Stack)
      .pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ GOBLIN_HARNESS_PORT: port + 70 }).pipe(
              ConfigProvider.orElse(ConfigProvider.fromEnv()),
            ),
          ),
        ),
      )
  }),
)

harness.test(
  'local workerd: decisions are labelled once and failures leave chat working',
  Effect.flatMap(stack, ({ url }) => decisionsCase(url)),
)
