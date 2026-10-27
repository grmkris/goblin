import type { ComposerOption, PersonaView } from '@goblin/contracts'

/** The Personas that answer: every one not archived, by name. */
export const activePersonas = (personas: readonly PersonaView[]): readonly PersonaView[] =>
  personas
    .filter((persona) => persona.archivedAt === undefined)
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

/** The Personas an installed app made, under its name, for display (ADR 0115). */
export type AppPersonas = { readonly app: string; readonly personas: readonly PersonaView[] }

/**
 * The Personas that answer, as the Personas page lists them: the owner's own by name, then those each installed app
 * made, one group per app by its name, each by name.
 */
export function personasByMaker(personas: readonly PersonaView[]): {
  readonly own: readonly PersonaView[]
  readonly apps: readonly AppPersonas[]
} {
  const active = activePersonas(personas)
  const byApp = new Map<string, PersonaView[]>()
  for (const persona of active) {
    if (persona.madeBy === undefined) continue
    const group = byApp.get(persona.madeBy.app)
    if (group === undefined) byApp.set(persona.madeBy.app, [persona])
    else group.push(persona)
  }
  return {
    own: active.filter((persona) => persona.madeBy === undefined),
    apps: [...byApp]
      .map(([app, made]) => ({ app, personas: made }))
      .toSorted((a, b) => a.app.localeCompare(b.app, undefined, { sensitivity: 'base' })),
  }
}

/** How many Personas a draft tags: with two or more the owner chooses whether they answer together or in turn. */
export const taggedPersonas = (selected: readonly ComposerOption[]): number =>
  selected.filter((option) => option.selection.kind === 'persona').length
