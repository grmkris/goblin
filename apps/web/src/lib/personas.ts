import type { ComposerOption, PersonaView } from '@goblin/contracts'

/** The Personas that answer: every one not archived, by name. */
export const activePersonas = (personas: readonly PersonaView[]): readonly PersonaView[] =>
  personas
    .filter((persona) => persona.archivedAt === undefined)
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

/** The Personas a server's API key made, under its name, for display (ADR 0115). */
export type KeyPersonas = { readonly key: string; readonly personas: readonly PersonaView[] }

/**
 * The Personas that answer, as the Personas page lists them: the owner's own by name, then those each key made, one
 * group per key by the key's name, each by name.
 */
export function personasByMaker(personas: readonly PersonaView[]): {
  readonly own: readonly PersonaView[]
  readonly keys: readonly KeyPersonas[]
} {
  const active = activePersonas(personas)
  const byKey = new Map<string, PersonaView[]>()
  for (const persona of active) {
    if (persona.madeBy === undefined) continue
    const group = byKey.get(persona.madeBy.key)
    if (group === undefined) byKey.set(persona.madeBy.key, [persona])
    else group.push(persona)
  }
  return {
    own: active.filter((persona) => persona.madeBy === undefined),
    keys: [...byKey]
      .map(([key, made]) => ({ key, personas: made }))
      .toSorted((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' })),
  }
}

/** How many Personas a draft tags: with two or more the owner chooses whether they answer together or in turn. */
export const taggedPersonas = (selected: readonly ComposerOption[]): number =>
  selected.filter((option) => option.selection.kind === 'persona').length
