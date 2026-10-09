import { GenerationTask, defineExtension, hook } from '@earendil-works/pi-durable'
import { considerOwnerYield } from '../decisions/program.ts'
import type { RunProgram } from './resident-mcp.ts'

/** Owner chats alone offer organization suggestions. Helpers and routine runs never install this extension. */
export function decisionsExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.decisions',
    hooks: [
      hook(GenerationTask, {
        onYield: (_answer, api) => {
          void run(considerOwnerYield(String(api.conversationId))).catch(() => undefined)
          return undefined
        },
      }),
    ],
  })
}
