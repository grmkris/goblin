// Adapted from grmkris/myapps packages/ui/src/auth/grant-reach.tsx (84525ee0), MIT, same author: its All or Choose
// specific items, for one kind of thing at a time. What changed: the list is searched in place rather than nested, a
// pick the list does not hold (yet) stays shown by its id, and it says how many are picked.
import { type ReactNode, useDeferredValue, useState } from 'react'
import { FieldLegend, FieldSet } from '../components/field.tsx'
import { Input } from '../components/input.tsx'
import { RadioGroup } from '../components/radio-group.tsx'
import { Skeleton } from '../components/skeleton.tsx'
import { GrantChoice } from './grant-terms.tsx'

/** All of a kind, or only the listed ids. */
export type ReachSelection = { readonly kind: 'all' } | { readonly kind: 'list'; readonly ids: readonly string[] }

/** One thing that can be picked. */
interface ReachItem {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
}

interface ReachListChoiceProps {
  /** The kind, plural, as a heading and in "All …" ("Topics"). */
  readonly noun: string
  /** What "All …" covers beyond what there is now. */
  readonly allHint?: string | undefined
  readonly value: ReachSelection
  readonly onChange: (value: ReachSelection) => void
  /** What may be picked; `undefined` while it loads. */
  readonly items: readonly ReachItem[] | undefined
  /** Why the items could not be read, in place of the list. */
  readonly failure?: ReactNode
  readonly disabled?: boolean | undefined
}

const matches = (item: ReachItem, query: string): boolean =>
  `${item.label} ${item.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())

/** The list to pick from: a search over it, and a checkbox per item; picks it does not hold come first, by id. */
function PickList(props: ReachListChoiceProps & { readonly ids: readonly string[] }) {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query.trim())
  const { items, ids, onChange, disabled } = props
  if (props.failure !== undefined)
    return (
      <p role="alert" className="m-0 text-sm text-destructive">
        {props.failure}
      </p>
    )
  if (items === undefined)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  const known = new Set(items.map((item) => item.id))
  const missing: readonly ReachItem[] = ids.filter((id) => !known.has(id)).map((id) => ({ id, label: `#${id}` }))
  const shown = [...missing, ...items].filter((item) => deferred === '' || matches(item, deferred))
  const toggle = (id: string, on: boolean) =>
    onChange({ kind: 'list', ids: on ? [...new Set([...ids, id])] : ids.filter((each) => each !== id) })
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <Input
          type="search"
          aria-label={`Search ${props.noun}`}
          placeholder={`Search ${props.noun}`}
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {ids.length} of {items.length + missing.length} picked
        </span>
      </div>
      <div
        role="group"
        aria-label={props.noun}
        className="flex max-h-64 min-w-0 flex-col overflow-y-auto overscroll-contain rounded-lg border border-hairline px-3"
      >
        {items.length === 0 && missing.length === 0 ? (
          <p className="m-0 py-2.5 text-sm text-muted-foreground">None yet.</p>
        ) : shown.length === 0 ? (
          <p className="m-0 py-2.5 text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          shown.map((item) => (
            <GrantChoice
              key={item.id}
              type="checkbox"
              checked={ids.includes(item.id)}
              label={item.label}
              description={item.description}
              disabled={disabled}
              onChange={(on) => toggle(item.id, on)}
            />
          ))
        )}
      </div>
    </div>
  )
}

/** One kind of thing a grant reaches: all of it (ones made later included), or those picked from its list. */
export function ReachListChoice(props: ReachListChoiceProps) {
  const { value, onChange, disabled, noun } = props
  return (
    <FieldSet data-slot="reach-list-choice">
      <FieldLegend variant="label">{`${noun.charAt(0).toLocaleUpperCase()}${noun.slice(1)}`}</FieldLegend>
      <RadioGroup
        aria-label={noun}
        value={value.kind}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'all') onChange({ kind: 'all' })
          else if (next === 'list' && value.kind === 'all') onChange({ kind: 'list', ids: [] })
        }}
      >
        <GrantChoice
          type="radio"
          value="all"
          checked={value.kind === 'all'}
          label={`All ${noun}`}
          description={props.allHint}
          disabled={disabled}
          onChange={() => onChange({ kind: 'all' })}
        />
        <GrantChoice
          type="radio"
          value="list"
          checked={value.kind === 'list'}
          label="Pick…"
          disabled={disabled}
          onChange={() => onChange({ kind: 'list', ids: [] })}
        />
      </RadioGroup>
      {value.kind === 'list' ? <PickList {...props} ids={value.ids} /> : null}
    </FieldSet>
  )
}
