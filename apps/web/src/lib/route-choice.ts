// Topic and Persona choices for a Source's conversation route.
import type { PersonaView, TopicView } from '@goblin/contracts'

export type RouteChoice = { readonly place: string; readonly responder: string }

/** The responder value for goblin itself; a Persona's is `persona:<id>`. */
export const GOBLIN = 'goblin'

const live = <T extends { readonly archivedAt?: number | undefined }>(items: readonly T[]): readonly T[] =>
  items.filter((item) => item.archivedAt === undefined)

/** The Persona a responder value names (`persona:<id>`); none for goblin. */
export function responderPersona(responder: string): number | undefined {
  const persona = Number(responder.split(':')[1])
  return responder.startsWith('persona:') && Number.isInteger(persona) && persona > 0 ? persona : undefined
}

/** One option of a select. */
export type Option = { readonly value: string; readonly text: string }

/** A run of options, under a label when it has one. */
export type OptionGroup = { readonly label?: string; readonly options: readonly Option[] }

/** A Topic as an option names it: by name, archived ones said so, one goblin does not list (just made) plainly. */
export function topicWords(id: number, topics: readonly TopicView[]): string {
  const topic = topics.find((each) => each.id === id)
  if (topic === undefined) return 'a new Topic'
  return topic.archivedAt === undefined ? `#${topic.name}` : `#${topic.name} (archived)`
}

/**
 * The Topics a route select offers: every live one, and the one `current` (`answer:<id>` or `listen:<id>`) names even
 * when it is not live, so the select always shows what is chosen.
 */
export function offeredTopics(topics: readonly TopicView[], current: string): readonly number[] {
  const shown = live(topics).map((topic) => topic.id)
  const [mode, where] = current.split(':')
  const held = Number(where)
  return (mode === 'answer' || mode === 'listen') && Number.isInteger(held) && held > 0 && !shown.includes(held)
    ? [...shown, held]
    : shown
}

/** Who answers in an answering route: goblin, or a live Persona; the one chosen is offered even when archived. */
export function responderOptions(personas: readonly PersonaView[], current: string): readonly Option[] {
  const id = Number(current.split(':')[1])
  const chosen = personas.find((persona) => persona.id === id)
  const offered = chosen?.archivedAt === undefined ? live(personas) : [...live(personas), chosen]
  return [
    { value: GOBLIN, text: 'goblin answers' },
    ...offered.map((persona) => ({
      value: `persona:${String(persona.id)}`,
      text: `@${persona.name}${persona.archivedAt === undefined ? '' : ' (archived)'} answers`,
    })),
  ]
}

/** Whether a choice answers back, so it names who does. */
export const answers = (choice: RouteChoice): boolean => choice.place.startsWith('answer:')

/** The messages a waiting chat holds, in words; none when it holds none. */
export function waitingWords(held: number): string | undefined {
  if (held <= 0) return undefined
  return held === 1 ? '1 message waiting' : `${String(held)} messages waiting`
}
