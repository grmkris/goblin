import { useMutation, useQuery } from '@tanstack/react-query'
import type { InvitationPreview } from '@goblin/contracts'
import { inWorkspace } from '../lib/workspace-path.ts'
import { acceptInvitationMutation, declineInvitationMutation, myInvitationsQuery } from './queries.ts'

const NONE: readonly InvitationPreview[] = []

/**
 * The invitations waiting for the signed-in person (ADR 0093). They are the person's, not a workspace's, so every
 * workspace's pages show the same ones; none until they are read, and none when the read fails.
 */
export const useMyInvitations = (): readonly InvitationPreview[] => useQuery(myInvitationsQuery).data ?? NONE

/**
 * Joining one invitation or turning it down, in place. Joining opens the workspace joined in this tab, as the workspace
 * menu opens one; turning it down drops it from the person's list.
 */
export function useAnswerInvitation(id: string) {
  const accept = useMutation(acceptInvitationMutation)
  const decline = useMutation(declineInvitationMutation)
  return {
    join: () => accept.mutate(id, { onSuccess: (joined) => window.location.assign(inWorkspace(joined.slug)) }),
    decline: () => decline.mutate(id),
    // Still joining until the joined workspace's page replaces this one.
    joining: accept.isPending || accept.isSuccess,
    declining: decline.isPending,
    failure: accept.error ?? decline.error,
  }
}
