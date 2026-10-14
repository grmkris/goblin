import { useMutation, useQuery } from '@tanstack/react-query'
import { AskCard, AskCardHeader, AskCardDescription, AskCardActions, Button, JsonView, Receipt } from '@goblin/ui'
import type { ApprovalView } from '@goblin/contracts'
import { CircleAlertIcon, KeyRoundIcon, LoaderCircleIcon } from 'lucide-react'
import { approvalQuery, decideApprovalMutation } from '../approvals/queries.ts'
import type { Interaction } from '../lib/interactions.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { useConnectionLabels } from '../mcp/hooks.ts'
import { UrlRequestCard } from './url-request-card.tsx'

type Approval = Extract<Interaction, { kind: 'approval' }>

/** Where a held call stands once the owner decided, in words, until it leaves the dock. */
const STANDING: Partial<Record<ApprovalView['state'], { readonly text: string; readonly error: boolean }>> = {
  approved: { text: 'Approved. Sending the call…', error: false },
  dispatching: { text: 'Sending the call…', error: false },
  expired: { text: 'This request ran out of time before you decided. Nothing ran.', error: true },
  failed: { text: 'The call was not sent. Nothing ran.', error: true },
  uncertain: {
    text: 'The answer was cut off. The call may have run: check on the server before trying again.',
    error: true,
  },
}

/** Where the call stands after the owner's decision: on its way, or what went wrong. */
function Standing({ text, error }: { readonly text: string; readonly error: boolean }) {
  return (
    <Receipt tone={error ? 'error' : 'neutral'}>
      {error ? (
        <CircleAlertIcon aria-hidden />
      ) : (
        <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />
      )}
      <span>{text}</span>
    </Receipt>
  )
}

/**
 * The owner reviews the durable call, not arguments supplied by remote content or the browser. It is read while it
 * waits; what went wrong deciding it, or reading it, shows on the card.
 */
export function ApprovalCard({ interaction }: { readonly interaction: Approval }) {
  const read = useQuery(approvalQuery(interaction.approvalId))
  const connection = useConnectionLabels()(interaction.connectionId)
  const decision = useMutation(decideApprovalMutation(interaction.approvalId))
  const view = read.data
  const busy = decision.isPending
  const error =
    decision.error !== null
      ? messageOf(decision.error, 'record your decision', { showRecovery: true })
      : read.error !== null
        ? messageOf(read.error, 'read the call')
        : ''
  const pending = view?.state === 'pending'
  // The server asked the owner to finish a step first (ADR 0042): the call goes on as that request.
  if (view?.urlRequest !== undefined) {
    const { callId, connectionId, name } = interaction
    return <UrlRequestCard interaction={{ kind: 'url', callId, requestId: view.urlRequest, connectionId, name }} />
  }
  if (view?.state === 'completed' || view?.state === 'refused') return null
  const standing = view === undefined ? undefined : STANDING[view.state]
  // Which answer is on its way, for the button that sent it.
  const refusing = decision.variables?.allowed === false
  return (
    <AskCard aria-label="Approve this call">
      <AskCardHeader>
        <KeyRoundIcon aria-hidden />
        <p>
          Approve{' '}
          <strong>
            {connection} · {interaction.name}
          </strong>
          ?
        </p>
      </AskCardHeader>
      <AskCardDescription>
        These exact arguments will run once if you approve. Credential fields are hidden.
      </AskCardDescription>
      {view !== undefined && <JsonView value={view.arguments} />}
      {standing !== undefined && <Standing {...standing} />}
      {error && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{error}</span>
        </Receipt>
      )}
      <AskCardActions>
        <Button
          variant="ghost"
          disabled={busy || !pending}
          pending={busy && refusing}
          onClick={() => decision.mutate({ allowed: false })}
        >
          Refuse
        </Button>
        <Button
          disabled={busy || !pending}
          pending={busy && !refusing}
          onClick={() => decision.mutate({ allowed: true })}
        >
          Approve once
        </Button>
      </AskCardActions>
    </AskCard>
  )
}
