import { type SubmitEvent as ReactSubmitEvent, type ReactNode, use, useMemo, useRef, useState } from 'react'
import { Renderer, type OpenUIError } from '@openuidev/react-lang'
import { reportUnexpected } from '../../../lib/unexpected.ts'
import { ReplySend } from './context.ts'
import { library } from './library.tsx'
import { replyMessage } from './message.ts'
import { programProblems } from './program.ts'

/** A complete reply program. Field state is local; a click uses the containing chat's existing send path. */
export function OpenUIBlock({ source, fallback }: { readonly source: string; readonly fallback: ReactNode }) {
  const send = use(ReplySend)
  const valid = useMemo(() => programProblems(source).length === 0, [source])
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const flight = useRef(false)
  const onError = (errors: OpenUIError[]) => {
    if (errors.some((error) => error.severity !== 'warning')) setFailed(true)
  }
  const submit = async (event: ReactSubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (send === undefined || flight.current) return
    const button = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null
    if (!(button instanceof HTMLButtonElement)) return
    const message = replyMessage(button.value, new FormData(event.currentTarget))
    if (message === undefined) {
      setNotice('These values could not be sent. Write your reply in the composer instead.')
      return
    }
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
  if (!valid || failed) return fallback
  return (
    <form
      className="not-typeset my-4 min-w-0"
      aria-label="Interactive reply"
      onSubmit={(event) => {
        submit(event).catch(reportUnexpected)
      }}
    >
      <fieldset disabled={send === undefined || pending} className="min-w-0">
        <Renderer response={source} library={library} onError={onError} publishObservability={false} />
      </fieldset>
      {notice !== '' && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </form>
  )
}
