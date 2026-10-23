// Adapted from grmkris/myapps packages/ui/src/auth/widen-approval.tsx (2b3da3d6), MIT, same author. What changed: it
// says what approving adds (a higher level, each extra, the reach the app names) above the two summaries; the app sends
// the request itself, so there is no fetch here; Approve and Deny stack on a phone and sit in a row from `sm`.
import { CheckIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../components/alert.tsx'
import { Button } from '../components/button.tsx'
import { FieldGroup } from '../components/field.tsx'
import { ActionIcon } from './action-icon.tsx'
import { GrantSummary, type GrantSummaryOptions } from './consent-summary.tsx'
import type { AuthActionResult } from './contract.ts'
import type { GrantSpecShape, GrantTermsShape, GrantWords } from './grant-terms.tsx'
import { useAction } from './use-action.ts'

const NOT_UPDATED = 'Could not update this access. Try again.'

/** What `requested` adds to `current`: a higher level and each extra it turns on. */
function wideningParts<L extends string, E extends string, R>(
  current: GrantTermsShape<L, E, R>,
  requested: GrantTermsShape<L, E, R>,
  spec: GrantSpecShape<L, E>,
  words: GrantWords<L, E>,
): readonly string[] {
  const higher = spec.levels.indexOf(requested.level) > spec.levels.indexOf(current.level)
  return [
    ...(higher
      ? [`${words.levels[requested.level].label} instead of ${words.levels[current.level].label.toLocaleLowerCase()}`]
      : []),
    ...spec.extras
      .filter((extra) => requested.extras.includes(extra.id) && !current.extras.includes(extra.id))
      .map((extra) => `${words.extras[extra.id].label}: ${words.extras[extra.id].description}`),
  ]
}

interface WidenApprovalProps<L extends string, E extends string, R> extends Omit<
  GrantSummaryOptions<L, E, R>,
  'terms' | 'clientName'
> {
  readonly current: GrantTermsShape<L, E, R>
  /** When the current access ends, in words ("until revoked", "on 12 Nov 2026"). */
  readonly currentEnds: string
  readonly requested: GrantTermsShape<L, E, R>
  /** What else approving adds that only the app can say: the reach it asks for, something it wants to create. */
  readonly asks?: readonly string[] | undefined
  /** Who asks, as the app identifies the credential. */
  readonly identity?: ReactNode
  /** Save exactly `requested`. */
  readonly onApprove: () => Promise<AuthActionResult>
  /** Leave the access as it is. */
  readonly onDeny: () => void
}

/** The access a credential has and the access it asks for, compared, then Approve or Deny. */
export function WidenApproval<L extends string, E extends string, R>(props: WidenApprovalProps<L, E, R>) {
  const action = useAction(NOT_UPDATED)
  const adds = [...wideningParts(props.current, props.requested, props.spec, props.words), ...(props.asks ?? [])]
  const summary = (terms: GrantTermsShape<L, E, R>) => <GrantSummary {...props} terms={terms} clientName={terms.name} />
  return (
    <FieldGroup data-slot="widen-approval">
      <Alert>
        <AlertTitle>Allow “{props.requested.name}” more access?</AlertTitle>
        <AlertDescription>
          {props.identity === undefined ? 'It' : props.identity} was refused something its access does not cover.
          Approving adds only what it asked for; nothing is taken away.
        </AlertDescription>
      </Alert>
      {adds.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-medium">Approving adds</h3>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-pretty">
            {adds.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-medium">Now</h3>
        <p className="m-0 text-sm text-muted-foreground">{summary(props.current)}</p>
        <p className="m-0 text-xs text-muted-foreground tabular-nums">Ends: {props.currentEnds}</p>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-medium">If you approve</h3>
        <p className="m-0 text-sm">{summary(props.requested)}</p>
      </section>
      {action.error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{action.error}</AlertDescription>
        </Alert>
      )}
      <div data-slot="decision" className="flex min-w-0 flex-col gap-2 sm:flex-row-reverse sm:justify-start">
        <Button
          type="button"
          size="lg"
          disabled={action.busy}
          aria-busy={action.busy}
          onClick={() => void action.run(props.onApprove)}
        >
          <ActionIcon icon={CheckIcon} busy={action.busy} />
          Approve
        </Button>
        <Button type="button" size="lg" variant="outline" disabled={action.busy} onClick={props.onDeny}>
          <XIcon data-icon="inline-start" />
          Deny
        </Button>
      </div>
    </FieldGroup>
  )
}
