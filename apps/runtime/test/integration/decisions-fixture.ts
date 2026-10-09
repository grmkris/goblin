import * as Effect from 'effect/Effect'
import { ClefError, type ClefClient } from '../../src/decisions/client.ts'

/** Native stacks never dispatch Workers AI network requests. */
export const unavailableClef: ClefClient = { evaluate: () => Effect.fail(new ClefError({ reason: 'unavailable' })) }
