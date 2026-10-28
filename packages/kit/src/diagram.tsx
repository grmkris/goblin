import { type Mounted, mountAsync } from 'pele/lazy'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { DiagramExplorer } from './diagram-explorer.tsx'
import { DIAGRAM_OPTIONS, diagramKind } from './diagram-render.ts'
import { sanitizeDiagramSvg } from './diagram-svg.ts'

/**
 * A Mermaid diagram drawn inline by Pele (ADR 0129), through the passive allowlist, with an optional read-only
 * explorer; a source Pele does not draw shows the fallback. Pele lays it out for its column's width and loads only
 * its kind's renderer; the page's tokens theme it through `--pele-*`, so a theme change redraws nothing.
 */
export function Diagram({
  source,
  fallback,
  interactive = true,
}: {
  readonly source: string
  readonly fallback: ReactNode
  readonly interactive?: boolean
}) {
  const scope = `kit-diagram-${useId().replaceAll(/[^a-zA-Z0-9_-]/gu, '-')}`
  const drawingRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState<string>()
  const label = `Diagram (${diagramKind(source)})`
  useEffect(() => {
    const element = drawingRef.current
    if (element === null) return
    let live = true
    let mounted: Mounted | undefined
    const fail = () => {
      if (live) setFailed(source)
    }
    const sanitize = (svg: string): Node => {
      const safe = sanitizeDiagramSvg(svg, label)
      if (safe !== undefined) return safe
      fail()
      return document.createDocumentFragment()
    }
    mountAsync(element, source, { ...DIAGRAM_OPTIONS, zoom: false, sanitize, onError: fail }).then((drawn) => {
      if (live) mounted = drawn
      else drawn.destroy()
    }, fail)
    return () => {
      live = false
      mounted?.destroy()
    }
  }, [source, label])
  if (failed === source) return fallback
  return (
    <figure className="kit-diagram">
      <div ref={drawingRef} className="kit-diagram-drawing" />
      {interactive && (
        <button
          ref={triggerRef}
          type="button"
          className="kit-diagram-explore"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          Explore diagram
        </button>
      )}
      {interactive && open && (
        <DiagramExplorer
          key={source}
          source={source}
          label={label}
          scope={scope}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
        />
      )}
    </figure>
  )
}
