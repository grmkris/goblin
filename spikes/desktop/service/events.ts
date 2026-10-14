/** At most one queued frame and one pending latest snapshot per slow client. */
export function events(initial: string, listeners: Set<(data: string) => void>): Response {
  const encoder = new TextEncoder()
  let pending: string | undefined
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let wakeup: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (controller && pending !== undefined && (controller.desiredSize ?? 0) > 0) {
      const frame = pending
      pending = undefined
      controller.enqueue(encoder.encode(frame))
      if (frame.startsWith('data:')) {
        // WebKitGTK can retain the last fetch chunk until the next write. Send a separate
        // comment after a burst so Stop/completion arrives promptly without idle polling.
        clearTimeout(wakeup)
        wakeup = setTimeout(() => {
          if (pending === undefined) send(': flush\n\n')
        }, 50)
      }
    }
  }
  const send = (frame: string) => {
    pending = frame
    flush()
  }
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next
      listeners.add(send)
      heartbeat = setInterval(() => {
        if (pending === undefined) send(': keepalive\n\n')
      }, 15000)
      send(initial)
    },
    pull: flush,
    cancel() {
      clearInterval(heartbeat)
      clearTimeout(wakeup)
      pending = undefined
      controller = undefined
      listeners.delete(send)
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}
