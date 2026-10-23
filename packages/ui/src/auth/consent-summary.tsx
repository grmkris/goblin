// Adapted from grmkris/myapps packages/ui/src/auth/consent-summary.tsx (2b3da3d6), MIT, same author. What changed: the
// app describes its own reach in words (goblin's nests Topics, Personas and connections in each workspace); extras
// read as one "with …" and one "no …" part; the editor under Change is the app's own, passed as children.
import { ChevronRightIcon, XIcon } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'
import { Button } from '../components/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/collapsible.tsx'
import { GRANT_LIFETIMES, type GrantSpecShape, type GrantTermsShape, type GrantWords } from './grant-terms.tsx'

export interface GrantSummaryOptions<L extends string, E extends string, R> {
  /** Who is granted: the client's or the key's name. */
  readonly clientName: string
  readonly terms: GrantTermsShape<L, E, R>
  readonly spec: GrantSpecShape<L, E>
  readonly words: GrantWords<L, E>
  /** The reach in words, as it reads after "can write": "everything in Acme". */
  readonly describeReach: (reach: R) => string
}

/** `items` as one phrase: "a", "a or b", "a, b or c". */
const listed = (items: readonly string[], last: string): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1) ?? ''}`

/** The summary's parts: who can do what where, the extras on and off, and how long. */
function grantSummaryParts<L extends string, E extends string, R>(
  options: GrantSummaryOptions<L, E, R>,
): readonly { readonly key: string; readonly text: string }[] {
  const { terms, spec, words } = options
  const label = (extra: E) => words.extras[extra].label.toLocaleLowerCase()
  const on = spec.extras.filter((extra) => terms.extras.includes(extra.id)).map((extra) => label(extra.id))
  const off = spec.extras.filter((extra) => !terms.extras.includes(extra.id)).map((extra) => label(extra.id))
  const lifetime = GRANT_LIFETIMES.find((option) => option.value === terms.lifetime)
  return [
    {
      key: 'level',
      text: `${options.clientName} can ${words.levels[terms.level].label.toLocaleLowerCase()} ${options.describeReach(terms.reach)}`,
    },
    ...(on.length === 0 ? [] : [{ key: 'with', text: `with ${listed(on, 'and')}` }]),
    ...(off.length === 0 ? [] : [{ key: 'without', text: `no ${listed(off, 'or')}` }]),
    {
      key: 'lifetime',
      text: lifetime === undefined || lifetime.value === 'never' ? 'until revoked' : `for ${lifetime.label}`,
    },
  ]
}

/**
 * The summary as one line of text.
 *
 * @internal the words the summary shows, for tests that read what it says.
 */
export const grantSummary = <L extends string, E extends string, R>(options: GrantSummaryOptions<L, E, R>): string =>
  grantSummaryParts(options)
    .map((part) => part.text)
    .join(' · ')

/**
 * The summary as running text. Each separator holds to the part before it (a no-break space), so a line that wraps
 * ends with one rather than starting with it.
 */
export function GrantSummary<L extends string, E extends string, R>(options: GrantSummaryOptions<L, E, R>) {
  return (
    <span data-slot="grant-summary" className="text-pretty">
      {grantSummaryParts(options).map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && <span className="text-muted-foreground">{'\u00a0· '}</span>}
          {part.text}
        </Fragment>
      ))}
    </span>
  )
}

interface ConsentSummaryProps<L extends string, E extends string, R> extends GrantSummaryOptions<L, E, R> {
  /** The editor that Change opens: the app's, controlled by the same terms. */
  readonly children: ReactNode
  readonly open?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  readonly disabled?: boolean | undefined
}

/** The terms in one line and Change, which opens the editor under it; approving uses the terms as they are then. */
export function ConsentSummary<L extends string, E extends string, R>(props: ConsentSummaryProps<L, E, R>) {
  const [own, setOwn] = useState(false)
  const open = props.open ?? own
  const setOpen = (next: boolean) => {
    setOwn(next)
    props.onOpenChange?.(next)
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="consent-summary">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-3">
        <p className="m-0 min-w-0 flex-1 basis-60 text-sm">
          <GrantSummary {...props} />
        </p>
        <CollapsibleTrigger
          render={<Button type="button" variant="outline" disabled={props.disabled} />}
          disabled={props.disabled}
        >
          {open ? <XIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
          {open ? 'Hide' : 'Change'}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>{open ? props.children : null}</CollapsibleContent>
    </Collapsible>
  )
}
