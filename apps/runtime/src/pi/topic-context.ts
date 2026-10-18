import { GenerationTask, type Harness, defineExtension, hook } from '@earendil-works/pi-durable'
import type { RunProgram } from '../runtime/bridge.ts'
import { topicContext } from '../topics/context.ts'
import { withContext } from './context-tail.ts'

/** Reads guidance before each request, so edits and reconstructed conversations see the current channel. */
export function topicContextExtension(run: RunProgram, abort: Harness['abortTask']) {
  return defineExtension({
    name: 'goblin.channel-guidance',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          try {
            const text = await run(topicContext(String(api.conversationId)))
            return text === undefined ? undefined : { messages: withContext(messages, 'channel', text) }
          } catch (error) {
            // Pi otherwise swallows hook failures. Its own invocation context cancels the self-abort join.
            await abort(api.taskId, context)
            throw error
          }
        },
      }),
    ],
  })
}
