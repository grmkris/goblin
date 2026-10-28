import { mountAsync } from 'pele/lazy'
import { type ReactNode, useId, useRef, useState } from 'react'
import { DiagramExplorer } from './diagram-explorer.tsx'
import { diagramKind } from './diagram-render.ts'
import { PeleDrawing } from './pele-drawing.tsx'

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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState<string>()
  const label = `Diagram (${diagramKind(source)})`
  if (failed === source) return fallback
  return (
    <figure className="kit-diagram">
      <PeleDrawing
        source={source}
        label={label}
        className="kit-diagram-drawing"
        mount={mountAsync}
        onFail={() => setFailed(source)}
      />
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
