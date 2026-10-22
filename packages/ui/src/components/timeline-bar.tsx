// Where one part sits within a whole (a step within its turn's time): a thin track with the part's span drawn to scale.
// In SVG so the span's start and length are attributes, as the usage ring's arc is. A failed part takes the destructive
// token. It is decoration (aria-hidden): say where the part sits in words beside it.
import { cn } from '../lib/cn'

function TimelineBar({
  start,
  length,
  failed = false,
  className,
}: {
  /** Where the span starts, in percent of the whole; clamped. */
  readonly start: number
  /** How long it is, in percent of the whole; clamped to what is left after `start`. */
  readonly length: number
  readonly failed?: boolean
  readonly className?: string
}) {
  const from = Math.min(100, Math.max(0, start))
  const span = Math.min(100 - from, Math.max(0, length))
  return (
    <svg
      data-slot="timeline-bar"
      data-failed={failed || undefined}
      aria-hidden
      viewBox="0 0 100 1"
      preserveAspectRatio="none"
      className={cn('group/timeline-bar h-1 w-full shrink-0 overflow-hidden rounded-full', className)}
    >
      <rect width="100" height="1" className="fill-muted" />
      <rect
        x={from}
        width={span}
        height="1"
        className="fill-primary/70 group-data-failed/timeline-bar:fill-destructive"
      />
    </svg>
  )
}

export { TimelineBar }
