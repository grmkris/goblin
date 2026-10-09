// Owner-only messages in a chat ("Only visible to you"): suggestions the owner can act on or dismiss, never part of
// the transcript (`EphemeralMessage`). The slot and its provider are here; decision proposals fill them
// (`decision-proposals.tsx`).
import { type ReactNode, createContext, use, useMemo, useState } from 'react'
import type { EphemeralMessage } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { EyeIcon, XIcon } from 'lucide-react'

type Ephemeral = {
  /** The owner-only messages of a chat, oldest first. */
  readonly of: (chat: string) => readonly EphemeralMessage[]
  /** The owner chose one of a message's actions (its stable id, which the runtime understands): the message goes. */
  readonly act: (message: EphemeralMessage, action: string) => void
  /** The owner dismissed a message: it goes. */
  readonly dismiss: (message: EphemeralMessage) => void
}

/** What the sender of a message does with the owner's choice; when it fails the message shows again. */
type Sent = Promise<void> | undefined

const EphemeralContext = createContext<Ephemeral>({ of: () => [], act: () => undefined, dismiss: () => undefined })

/**
 * Gives the chats below their owner-only messages: `initial` (none until the runtime sends any) less those the owner
 * acted on or dismissed, which go at once. An action goes to `onAction` and a dismissal to `onDismiss`; a message whose
 * sender fails shows again, so the owner can choose again.
 */
export function EphemeralProvider({
  initial = [],
  onAction = () => undefined,
  onDismiss = () => undefined,
  children,
}: {
  readonly initial?: readonly EphemeralMessage[]
  readonly onAction?: (message: EphemeralMessage, action: string) => Sent
  readonly onDismiss?: (message: EphemeralMessage) => Sent
  readonly children: ReactNode
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const value = useMemo<Ephemeral>(() => {
    const show = (id: string, shown: boolean) =>
      setHidden((current) => {
        const next = new Set(current)
        if (shown) next.delete(id)
        else next.add(id)
        return next
      })
    const settle = (message: EphemeralMessage, send: () => Sent) => {
      show(message.id, false)
      void Promise.resolve()
        .then(send)
        .catch(() => show(message.id, true))
    }
    return {
      of: (chat) => initial.filter((message) => message.chat === chat && !hidden.has(message.id)),
      act: (message, action) => settle(message, () => onAction(message, action)),
      dismiss: (message) => settle(message, () => onDismiss(message)),
    }
  }, [initial, onAction, onDismiss, hidden])
  return <EphemeralContext value={value}>{children}</EphemeralContext>
}

/** The owner-only messages of `chat`, and what the owner can do with them. */
export function useEphemeral(chat: string) {
  const ephemeral = use(EphemeralContext)
  return { messages: ephemeral.of(chat), act: ephemeral.act, dismiss: ephemeral.dismiss }
}

const VARIANT = { primary: 'default', neutral: 'outline', danger: 'destructive' } as const

/** One owner-only message: who sees it, its title and words, its actions, and Dismiss. */
export function EphemeralRow({
  message,
  onAction,
  onDismiss,
}: {
  readonly message: EphemeralMessage
  readonly onAction: (action: string) => void
  readonly onDismiss: () => void
}) {
  return (
    <aside className="ephemeral" aria-label={message.title}>
      <p className="ephemeral-who">
        <EyeIcon aria-hidden />
        Only visible to you
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon />
        </Button>
      </p>
      <p className="ephemeral-title">{message.title}</p>
      <p className="ephemeral-body">{message.body}</p>
      {message.actions.length > 0 && (
        <div className="ephemeral-actions">
          {message.actions.map((action) => (
            <Button key={action.id} size="sm" variant={VARIANT[action.tone]} onClick={() => onAction(action.id)}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </aside>
  )
}
