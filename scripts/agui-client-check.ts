/**
 * `bun scripts/agui-client-check.ts`: a stock AG-UI client drives a stage (ADR 0111). Given `GOBLIN_ORIGIN` (the
 * stage's app origin) and `GOBLIN_KEY` (a server's key with the `topics` and `conversations` scopes), it makes a Topic,
 * runs one turn there with `@ag-ui/client`'s `HttpAgent` (which checks every event with its own verifier), prints the
 * event types and whether the verifier passed, never what was said, and archives the Topic again. Not run by CI: the
 * turn spends a model call.
 */
import { HttpAgent } from '@ag-ui/client'
import { Config, Effect, Redacted, Schema } from 'effect'
import { TopicView } from '../packages/contracts/src/topics.ts'

const settings = Effect.gen(function* () {
  return {
    origin: new URL(yield* Config.String('GOBLIN_ORIGIN')).origin,
    key: yield* Config.Redacted('GOBLIN_KEY'),
  }
})

const { origin, key } = await Effect.runPromise(settings)
const auth = { authorization: `Bearer ${Redacted.value(key)}` }

/** A JSON request to the stage's owner API with the key. */
async function send(method: string, path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`)
  return response
}

const stamp = new Date().toISOString().replaceAll(/\D/gu, '').slice(0, 14)
const topic = Schema.decodeUnknownSync(TopicView)(
  await (
    await send('POST', '/api/topics', { name: `AG-UI check ${stamp}`, operationId: `agui-check:${stamp}` })
  ).json(),
)
const types: string[] = []
let verifier = 'passed'
try {
  const agent = new HttpAgent({
    url: `${origin}/api/conversations/${topic.conversation}/messages`,
    headers: auth,
    threadId: topic.conversation,
  })
  agent.addMessage({ id: `agui-check:${stamp}:user`, role: 'user', content: 'Say hello in one short sentence.' })
  await agent.runAgent(
    { runId: `agui-check:${stamp}:run` },
    {
      onEvent: ({ event }) => {
        types.push(event.type)
      },
    },
  )
} catch (cause) {
  // expected: the check reports what the client refused by its error's class only, never its message
  verifier = cause instanceof Error ? `failed (${cause.name})` : 'failed'
} finally {
  await send('PATCH', `/api/topics/${topic.id}`, { archived: true })
}
console.log(JSON.stringify({ topic: topic.id, events: types, verifier }, null, 2))
if (verifier !== 'passed') process.exitCode = 1
