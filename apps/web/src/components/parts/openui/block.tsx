import {
  type KeyboardEvent as ReactKeyboardEvent,
  type SubmitEvent as ReactSubmitEvent,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Renderer, type OpenUIError } from '@openuidev/react-lang'
import { reportUnexpected } from '../../../lib/unexpected.ts'
import { ReplySend } from './context.ts'
import { library } from './library.tsx'
import { replyMessage } from './message.ts'
import { checkProgram } from './program.ts'

/**
 * Enter in a field sends the form's first button (HTML's implicit submission). With one button that is the owner's
 * only choice; with several it would send a choice they never made, so they pick the button themselves.
 */
function keepEnterToOneButton(event: ReactKeyboardEvent<HTMLFormElement>) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement)) return
  const buttons = [...event.currentTarget.elements].filter(
    (element) => element instanceof HTMLButtonElement && element.type === 'submit',
  )
  if (buttons.length !== 1) event.preventDefault()
}

/** The button that sent the form; undefined when no button did. */
function submitterOf(event: ReactSubmitEvent<HTMLFormElement>): HTMLButtonElement | undefined {
  const button = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null
  return button instanceof HTMLButtonElement ? button : undefined
}

/** A complete reply program. Field state is local; a click uses the containing chat's existing send path. */
export function OpenUIBlock({ source, fallback }: { readonly source: string; readonly fallback: ReactNode }) {
  const send = use(ReplySend)
  const checked = useMemo(() => checkProgram(source), [source])
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const flight = useRef(false)
  // Disabling the form while it sends drops the owner's focus; it returns to where they sent from.
  const sentFrom = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (pending) return
    sentFrom.current?.focus()
    sentFrom.current = null
  }, [pending])
  const onError = (errors: OpenUIError[]) => {
    if (errors.some((error) => error.severity !== 'warning')) setFailed(true)
  }
  const submit = async (event: ReactSubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (send === undefined || flight.current) return
    const button = submitterOf(event)
    if (button === undefined) return
    const message = replyMessage(button.value, new FormData(event.currentTarget))
    if (message === undefined) {
      setNotice('These values could not be sent. Write your reply in the composer instead.')
      return
    }
    const focused = document.activeElement
    sentFrom.current = focused instanceof HTMLElement && event.currentTarget.contains(focused) ? focused : null
    flight.current = true
    setPending(true)
    setNotice('')
    try {
      const accepted = await send(message)
      setNotice(accepted ? 'Reply recorded.' : 'Could not send. Try again; your values are kept here.')
    } catch {
      // expected: the host reports transport failures; preserve the local form for a retry.
      setNotice('Could not send. Try again; your values are kept here.')
    } finally {
      flight.current = false
      setPending(false)
    }
  }
  if (!checked.ok || failed) return fallback
  return (
    <form
      className="not-typeset my-4 min-w-0"
      aria-label="Interactive reply"
      onKeyDown={keepEnterToOneButton}
      onSubmit={(event) => {
        submit(event).catch(reportUnexpected)
      }}
    >
      <fieldset disabled={send === undefined || pending} className="min-w-0">
        <Renderer response={checked.program} library={library} onError={onError} publishObservability={false} />
      </fieldset>
      {/* Mounted while empty, so a screen reader is already listening when a notice arrives. */}
      <p role="status" className="text-sm text-muted-foreground">
        {notice}
      </p>
    </form>
  )
}
