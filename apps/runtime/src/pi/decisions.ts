import { GenerationTask, defineExtension, hook } from '@earendil-works/pi-durable'
import { chosenContext, considerOwnerYield } from '../decisions/program.ts'
import { withContext } from './context-tail.ts'
import type { RunProgram } from './resident-mcp.ts'

/**
 * Owner chats alone offer organization and context suggestions (ADR 0031). Helpers and routine runs never install this
 * extension. After a final answer the exchange is judged; before each request, earlier work the owner chose to use in
 * the chat joins goblin's context block (for that request only, never the transcript). A failure changes neither.
 */
export function decisionsExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.decisions',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          const chosen = await run(chosenContext(String(api.conversationId))).catch(() => undefined)
          return chosen === undefined ? undefined : { messages: withContext(messages, 'chosen-context', chosen) }
        },
        onYield: (_answer, api) => {
          void run(considerOwnerYield(String(api.conversationId))).catch(() => undefined)
          return undefined
        },
      }),
    ],
  })
}
