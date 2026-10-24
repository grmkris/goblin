// Adapted from grmkris/myapps packages/ui/src/agents/grant-terms.tsx (1f10a299) and the choice row of
// packages/ui/src/auth/grant-reach.tsx (84525ee0), MIT, same author. What changed: goblin's six lifetimes; each level
// and extra shows the app's own words (a label and one line) beside its control, the whole row its hit area; a risky
// extra wears a Risky badge; the reach is the app's own controls, passed in, since goblin's reach nests Topics,
// Personas and connections in each workspace.
import { type ReactNode, useId } from 'react'
import { Badge } from '../components/badge.tsx'
import { Checkbox } from '../components/checkbox.tsx'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../components/field.tsx'
import { NativeSelect, NativeSelectOption } from '../components/native-select.tsx'
import { RadioGroup, RadioGroupItem } from '../components/radio-group.tsx'

/** How long an approval lasts: until revoked, or 1, 7, 30, 90 or 365 days. */
type GrantLifetime = 'never' | '1d' | '7d' | '30d' | '90d' | '365d'

export const GRANT_LIFETIMES: readonly { readonly value: GrantLifetime; readonly label: string }[] = [
  { value: 'never', label: 'Until revoked' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '1 year' },
]

/** A grant's terms as the editor changes them; the app's own type, with its reach `R`, passes through unchanged. */
export interface GrantTermsShape<L extends string, E extends string, R> {
  readonly name: string
  readonly level: L
  readonly reach: R
  readonly extras: readonly E[]
  readonly lifetime: GrantLifetime
}

/** One extra the editor offers: a risky one is marked. */
interface GrantExtraOption<E extends string> {
  readonly id: E
  readonly risky: boolean
}

/** The levels in order, least first, and the extras. */
export interface GrantSpecShape<L extends string, E extends string> {
  readonly levels: readonly L[]
  readonly extras: readonly GrantExtraOption<E>[]
}

/** A level's or an extra's name and what it allows, in one line; `note` is said quietly after it. */
interface GrantWord {
  readonly label: string
  readonly description: string
  readonly note?: string
}

/** What the app calls each level and extra. */
export interface GrantWords<L extends string, E extends string> {
  readonly levels: Readonly<Record<L, GrantWord>>
  readonly extras: Readonly<Record<E, GrantWord>>
}

/**
 * One radio or checkbox with its label and line. The row is the label, so all of it is the hit area: at least 40px
 * tall, 44px under a finger.
 */
export function GrantChoice(props: {
  readonly type: 'radio' | 'checkbox'
  readonly value?: string | undefined
  readonly checked: boolean
  readonly label: ReactNode
  readonly description?: ReactNode
  readonly badge?: ReactNode
  readonly disabled?: boolean | undefined
  readonly onChange: (checked: boolean) => void
}) {
  return (
    <label
      data-slot="grant-choice"
      data-disabled={props.disabled === true || undefined}
      className="flex min-h-10 min-w-0 cursor-pointer items-start gap-3 py-2.5 pointer-coarse:min-h-11 data-disabled:cursor-default data-disabled:opacity-60"
    >
      <span className="flex h-5 shrink-0 items-center">
        {props.type === 'radio' ? (
          <RadioGroupItem value={props.value ?? ''} disabled={props.disabled} />
        ) : (
          <Checkbox
            checked={props.checked}
            disabled={props.disabled}
            onCheckedChange={(checked) => props.onChange(checked)}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm leading-5 font-medium">
          {props.label}
          {props.badge}
        </span>
        {props.description === undefined ? null : (
          <span className="text-sm text-pretty text-muted-foreground">{props.description}</span>
        )}
      </span>
    </label>
  )
}

interface GrantTermsEditorProps<
  L extends string,
  E extends string,
  R,
  T extends GrantTermsShape<L, E, R> = GrantTermsShape<L, E, R>,
> {
  readonly terms: T
  readonly spec: GrantSpecShape<L, E>
  readonly words: GrantWords<L, E>
  readonly onChange: (terms: T) => void
  /** The app's controls for the reach, between the level and the extras. */
  readonly reach: ReactNode
  readonly disabled?: boolean | undefined
  /** More of the grant after its lifetime (what else the app's grants hold). */
  readonly children?: ReactNode
}

function LevelChoices<L extends string, E extends string, R, T extends GrantTermsShape<L, E, R>>(
  props: GrantTermsEditorProps<L, E, R, T>,
) {
  const { terms, spec, words, onChange, disabled } = props
  return (
    <FieldSet>
      <FieldLegend variant="label">Access level</FieldLegend>
      <RadioGroup
        aria-label="Access level"
        value={terms.level}
        disabled={disabled}
        onValueChange={(value) => {
          const level = spec.levels.find((candidate) => candidate === value)
          if (level !== undefined) onChange({ ...terms, level })
        }}
      >
        {spec.levels.map((level) => (
          <GrantChoice
            key={level}
            type="radio"
            value={level}
            checked={terms.level === level}
            label={words.levels[level].label}
            description={words.levels[level].description}
            disabled={disabled}
            onChange={() => onChange({ ...terms, level })}
          />
        ))}
      </RadioGroup>
    </FieldSet>
  )
}

function ExtraChoices<L extends string, E extends string, R, T extends GrantTermsShape<L, E, R>>(
  props: GrantTermsEditorProps<L, E, R, T>,
) {
  const { terms, spec, words, onChange, disabled } = props
  if (spec.extras.length === 0) return null
  return (
    <FieldSet>
      <FieldLegend variant="label">Extras</FieldLegend>
      <div className="flex flex-col">
        {spec.extras.map((extra) => {
          const word = words.extras[extra.id]
          const on = terms.extras.includes(extra.id)
          const lines = [word.description, word.note].filter((line) => line !== undefined)
          return (
            <GrantChoice
              key={extra.id}
              type="checkbox"
              checked={on}
              label={word.label}
              description={lines.join(' ')}
              badge={extra.risky ? <Badge variant="outline">Risky</Badge> : undefined}
              disabled={disabled}
              onChange={(checked) =>
                onChange({
                  ...terms,
                  extras: checked
                    ? [...new Set([...terms.extras, extra.id])]
                    : terms.extras.filter((id) => id !== extra.id),
                })
              }
            />
          )
        })}
      </div>
    </FieldSet>
  )
}

/** The grant's lifetime, from now. */
function LifetimeField<L extends string, E extends string, R, T extends GrantTermsShape<L, E, R>>(
  props: GrantTermsEditorProps<L, E, R, T>,
) {
  const id = useId()
  const { terms, onChange, disabled } = props
  return (
    <Field>
      <FieldLabel htmlFor={id}>Access lasts</FieldLabel>
      <NativeSelect
        id={id}
        disabled={disabled}
        value={terms.lifetime}
        onChange={(event) => {
          const lifetime = GRANT_LIFETIMES.find((option) => option.value === event.target.value)?.value
          if (lifetime !== undefined) onChange({ ...terms, lifetime })
        }}
      >
        {GRANT_LIFETIMES.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  )
}

/** A grant's level, reach, extras and lifetime, controlled: every change is the whole terms, handed back. */
export function GrantTermsEditor<L extends string, E extends string, R, T extends GrantTermsShape<L, E, R>>(
  props: GrantTermsEditorProps<L, E, R, T>,
) {
  return (
    <FieldSet data-slot="grant-terms-editor" disabled={props.disabled}>
      <FieldGroup>
        <LevelChoices {...props} />
        {props.reach}
        <ExtraChoices {...props} />
        <LifetimeField {...props} />
        {props.children}
      </FieldGroup>
    </FieldSet>
  )
}
