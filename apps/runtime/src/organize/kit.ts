import type { ForkToolsKit } from '../pi/fork-tools.ts'
import { organizeExtension } from '../pi/organize.ts'
import { type PersonaTurnKit, personaTurnExtension } from '../pi/persona-turn.ts'
import type { RunProgram } from '../runtime/bridge.ts'

export type { PersonaTurnKit }

/**
 * What the Agent adds for Personas and organizing (ADR 0033): the Persona turn kit (its extension is selected by a
 * Persona's fork alone, which freezes its native tools with `tools`, ADR 0101) and the organize tools every
 * Conversation and thread has.
 */
export function organizingKit(run: RunProgram, tools: ForkToolsKit) {
  return { personas: personaTurnExtension(run, tools), organize: organizeExtension(run) }
}
