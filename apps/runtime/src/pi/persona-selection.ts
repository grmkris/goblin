import type { AgentState } from '@earendil-works/pi-durable'

// What a Persona's fork selects (ADR 0033): the chat's selection at the cut, with what a Persona never has left out.

/**
 * The tools a Persona never has: it does not delegate, loop or organize. It may ask the owner with `ask_user`, which
 * ends its answer (ADR 0082).
 */
export const PERSONA_DENIED_TOOLS: readonly string[] = [
  'subagent_spawn',
  'subagent_send',
  'subagent_stop',
  'subagent_status',
  'subagent_config',
  'share_back',
  'topic_create',
  'topic_rename',
  'topic_archive',
  'topic_setup',
  'persona_create',
  'persona_update',
  'source_routes',
  'source_route',
  'source_propose',
  'routine_propose',
  'routine_pause',
]

/** Extensions a Persona's fork leaves out: main's memory belongs to Goblin, not to a Persona. */
const PERSONA_LEFT_OUT = ['goblin.memory']
/** The Persona turn's extension (`persona-turn.ts`), which only a fork selects. */
export const PERSONA_EXTENSION = 'goblin.persona-turn'

/** The extension names with the Persona turn extension, added once. */
const withTurn = (names: readonly string[]) =>
  names.includes(PERSONA_EXTENSION) ? [...names] : [...names, PERSONA_EXTENSION]

/**
 * The fork's stored selection with the Persona's changes: extensions without main's memory and with the Persona turn
 * extension, tools without the ones a Persona never has. Names only, as Pi stores them; an exact list stays exact.
 */
export function personaSelection(
  state: Pick<AgentState, 'extensions' | 'tools'>,
  denied: readonly string[] = PERSONA_DENIED_TOOLS,
): Pick<AgentState, 'extensions' | 'tools'> {
  const extensions = state.extensions
  const leftOut = new Set(PERSONA_LEFT_OUT)
  const kept = (names: readonly string[] | undefined) => (names ?? []).filter((name) => !leftOut.has(name))
  const nextExtensions = Array.isArray(extensions)
    ? withTurn(kept(extensions))
    : {
        add: withTurn(kept(extensions?.add)),
        remove: [...new Set([...(extensions?.remove ?? []), ...PERSONA_LEFT_OUT])].filter(
          (name) => name !== PERSONA_EXTENSION,
        ),
      }
  const tools = state.tools
  const nextTools = Array.isArray(tools)
    ? tools.filter((name) => !denied.includes(name))
    : { remove: [...new Set([...(tools?.remove ?? []), ...denied])] }
  return { extensions: nextExtensions, tools: nextTools }
}
