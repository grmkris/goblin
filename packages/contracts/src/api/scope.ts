import * as Context from 'effect/Context'
import type { CallerScope } from '../account.ts'

/**
 * The scope an owner endpoint accepts a caller for (ADRs 0081, 0086): a server's API key or an OAuth client of the
 * owner that holds it. An endpoint without one refuses every caller before the agent runs; the owner's session reaches
 * it as before.
 */
export const EndpointScope = Context.Reference<CallerScope | undefined>('goblin/api/EndpointScope', {
  defaultValue: () => undefined,
})
