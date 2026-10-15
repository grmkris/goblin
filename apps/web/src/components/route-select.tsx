import { Fragment } from 'react'
import type { PersonaView, TopicView } from '@goblin/contracts'
import { NativeSelect, NativeSelectOption } from '@goblin/ui'
import { type Option, type OptionGroup, type RouteChoice, answers, responderOptions } from '../lib/route-choice.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'

/** Where a route can go: every Topic and Persona (the selects list the live ones, an archived one only while chosen). */
export type RoutePlaces = { readonly topics: readonly TopicView[]; readonly personas: readonly PersonaView[] }

export const useRoutePlaces = (): RoutePlaces => ({ topics: useTopics(), personas: usePersonas() })

const option = ({ value, text }: Option) => (
  <NativeSelectOption key={value} value={value}>
    {text}
  </NativeSelectOption>
)

/**
 * Where something's messages go (`groups`, the place select's options) and beside it, when they are answered, who
 * answers: goblin or a Persona. `name` is what the selects are about, for their labels. Source conversations choose with it.
 */
export function PlaceSelects({
  name,
  choice,
  groups,
  personas,
  onChoose,
}: {
  readonly name: string
  readonly choice: RouteChoice
  readonly groups: readonly OptionGroup[]
  readonly personas: readonly PersonaView[]
  readonly onChoose: (choice: RouteChoice) => void
}) {
  return (
    <span className="source-route">
      <NativeSelect
        size="sm"
        aria-label={`Where “${name}” goes`}
        value={choice.place}
        onChange={(event) => onChoose({ ...choice, place: event.target.value })}
      >
        {choice.place === '' && (
          <NativeSelectOption value="" disabled>
            Choose where it goes
          </NativeSelectOption>
        )}
        {groups.map((group, index) => (
          // The groups are fixed in number and order, so their place names them.
          <Fragment key={group.label ?? `plain-${String(index)}`}>
            {group.label === undefined ? (
              group.options.map(option)
            ) : (
              <optgroup label={group.label}>{group.options.map(option)}</optgroup>
            )}
          </Fragment>
        ))}
      </NativeSelect>
      {answers(choice) && (
        <NativeSelect
          size="sm"
          aria-label={`Who answers in “${name}”`}
          value={choice.responder}
          onChange={(event) => onChoose({ ...choice, responder: event.target.value })}
        >
          {responderOptions(personas, choice.responder).map(option)}
        </NativeSelect>
      )}
    </span>
  )
}
