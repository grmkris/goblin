import type { InvitationPreview } from '@goblin/contracts'
import { Conflict, Forbidden, NotFound } from '@goblin/contracts/api'
import { messageOf, withRef } from '../lib/query/app-error.ts'

/**
 * What the person reads when joining or turning down an invitation was refused (ADRs 0093, 0095): the server's own
 * reason in their words, else the generic failure. Only the person it is for gets this far, so the copy speaks to them.
 */
export function invitationRefusal(
  failure: unknown,
  invitation: Pick<InvitationPreview, 'workspace' | 'invitedBy'>,
): string {
  if (failure instanceof Conflict)
    switch (failure.reason) {
      case 'owner_models':
        return withRef(
          `${invitation.workspace} offers its owner's own subscription models, which serve only them, so it takes no members.`,
          failure,
        )
      case 'expired':
        return withRef(`This invitation has expired. Ask ${invitation.invitedBy} for a new one.`, failure)
      case 'canceled':
        return withRef('This invitation was withdrawn.', failure)
      case 'accepted':
        return withRef(`You already joined ${invitation.workspace}.`, failure)
      case 'declined':
        return withRef('You already turned this invitation down.', failure)
    }
  if (failure instanceof Forbidden && failure.reason === 'invitation_email')
    return withRef('This invitation is for another address.', failure)
  if (failure instanceof NotFound)
    return withRef(
      failure.what === 'workspace' ? `${invitation.workspace} no longer exists.` : 'This invitation no longer exists.',
      failure,
    )
  return messageOf(failure, 'answer the invitation')
}
