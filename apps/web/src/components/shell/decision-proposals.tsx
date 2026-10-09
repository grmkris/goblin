import { type ReactNode, useCallback, useMemo } from 'react'
import type { DecisionLabel, EphemeralMessage } from '@goblin/contracts'
import { AttachmentDraft } from '../../lib/attachment-draft.ts'
import { labelOf, opensThread, proposalMessages, sendLabel } from '../../lib/decisions.ts'
import { useNavigation } from '../../lib/navigation.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { EphemeralProvider } from './ephemeral-slot.tsx'

/**
 * The runtime's decision proposals (ADR 0031) as the chats' "Only visible to you" rows: each open proposal shows in its
 * chat with its confirm and Dismiss. The owner's choice is kept as a label (`POST /api/decisions/:id`); confirming
 * "this could be a thread" then opens an empty new thread's draft in that chat's channel. Nothing moves and nothing is
 * sent on the owner's behalf.
 */
export function DecisionProposals({ children }: { readonly children: ReactNode }) {
  const { proposals, apply } = useWorkspaceFeed()
  const navigation = useNavigation()
  const messages = useMemo(() => proposalMessages(proposals), [proposals])
  const decide = useCallback(
    async (message: EphemeralMessage, label: DecisionLabel['label']) => {
      const proposal = await sendLabel(message.id, label)
      if (proposal === undefined) return
      apply([{ type: 'proposal', proposal }])
      if (opensThread(proposal))
        navigation.newThreadWith({ text: '', selections: [], attachments: new AttachmentDraft() }, proposal.chatId)
    },
    [apply, navigation],
  )
  const onAction = useCallback(
    (message: EphemeralMessage, action: string) => {
      const label = labelOf(action)
      return label === undefined ? undefined : decide(message, label)
    },
    [decide],
  )
  const onDismiss = useCallback((message: EphemeralMessage) => decide(message, 'dismiss'), [decide])
  return (
    <EphemeralProvider initial={messages} onAction={onAction} onDismiss={onDismiss}>
      {children}
    </EphemeralProvider>
  )
}
