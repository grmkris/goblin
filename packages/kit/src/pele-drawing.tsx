import type { MountOptions, Mounted } from 'pele/core'
import { useEffect, useRef } from 'react'
import { DIAGRAM_OPTIONS } from './pele-options.ts'
import { sanitizeDiagramSvg } from './diagram-svg.ts'

/** How a drawing is mounted: `pele/lazy`'s `mountAsync`, or `pele/core`'s `mount` over the kinds a module registered. */
export type PeleMount = (element: HTMLElement, text: string, options: MountOptions) => Promise<Mounted>

/**
 * Pele's drawing of `source` mounted into a box with `mount`, through the passive allowlist (ADR 0129): laid out for the
 * box's width, themed by the page's `--pele-*` tokens. Diagrams mount through `pele/lazy` (any kind, its renderer loaded
 * on first use), charts through `pele/core` with their two kinds registered. `onFail` hears a source Pele does not
 * draw, or a drawing the allowlist refuses; the caller shows its fallback.
 */
export function PeleDrawing({
  source,
  label,
  className,
  options = DIAGRAM_OPTIONS,
  mount,
  onFail,
}: {
  readonly source: string
  readonly label: string
  readonly className: string
  readonly options?: Omit<MountOptions, 'sanitize' | 'onError' | 'zoom'>
  readonly mount: PeleMount
  readonly onFail: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  // The caller's latest `onFail`, so a new callback each render does not draw again.
  const fail = useRef(onFail)
  useEffect(() => {
    fail.current = onFail
  })
  useEffect(() => {
    const element = box.current
    if (element === null) return
    let live = true
    let mounted: Mounted | undefined
    const failed = () => {
      if (live) fail.current()
    }
    const sanitize = (svg: string): Node => {
      const safe = sanitizeDiagramSvg(svg, label)
      if (safe !== undefined) return safe
      failed()
      return document.createDocumentFragment()
    }
    mount(element, source, { ...options, zoom: false, sanitize, onError: failed }).then((drawn) => {
      if (live) mounted = drawn
      else drawn.destroy()
    }, failed)
    return () => {
      live = false
      mounted?.destroy()
    }
  }, [source, label, options, mount])
  return <div ref={box} className={className} />
}
