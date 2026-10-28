import { type RefObject, useEffect, useRef, useState } from 'react'
import { diagramLinks } from './diagram-graph.ts'
import { diagramPan } from './diagram-pan.ts'
import { diagramInteraction } from './diagram-interaction.ts'
import { diagramSvg } from './diagram-render.ts'
import { sanitizeDiagramSvg } from './diagram-svg.ts'

type ExplorerProps = {
  readonly source: string
  readonly label: string
  readonly scope: string
  readonly onClose: () => void
  readonly triggerRef: RefObject<HTMLButtonElement | null>
}

/** Draws the source again at its natural size, through the same allowlist, then lets it be panned, zoomed and read. */
function useExplorer({ source, label, triggerRef }: ExplorerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const controls = useRef<ReturnType<typeof diagramPan>>(undefined)
  const interaction = useRef<ReturnType<typeof diagramInteraction>>(undefined)
  const [selected, setSelected] = useState(false)
  const [scale, setScale] = useState(1)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (dialog === null || viewport === null || canvas === null) return
    const trigger = triggerRef.current
    let live = true
    dialog.showModal()
    dialog.querySelector<HTMLButtonElement>('[data-diagram-close]')?.focus()
    const draw = ([svg, links]: readonly [string | undefined, Awaited<ReturnType<typeof diagramLinks>>]) => {
      const drawing = svg === undefined ? undefined : sanitizeDiagramSvg(svg, label)
      if (!live || drawing === undefined) return
      canvas.replaceChildren(drawing)
      controls.current = diagramPan(viewport, canvas, setScale)
      interaction.current = diagramInteraction(viewport, drawing, links, (node, count) => {
        setSelected(node !== undefined)
        setAnnouncement(node === undefined ? 'Selection cleared.' : `${node.label} selected. ${count} connected nodes.`)
      })
    }
    Promise.all([diagramSvg(source), diagramLinks(source)]).then(draw, () => {
      // expected: neither rejects (each answers nothing for a source it cannot draw); the canvas stays empty
    })
    return () => {
      live = false
      controls.current?.destroy()
      controls.current = undefined
      interaction.current?.destroy()
      interaction.current = undefined
      dialog.close()
      trigger?.focus()
    }
  }, [source, label, triggerRef])

  return { dialogRef, viewportRef, canvasRef, controls, interaction, selected, scale, announcement }
}

/** Mounted only while exploring. Native modality confines focus, including within an app's sandbox frame. */
export function DiagramExplorer(props: ExplorerProps) {
  const { scope, onClose } = props
  const { dialogRef, viewportRef, canvasRef, controls, interaction, selected, scale, announcement } = useExplorer(props)
  return (
    <dialog
      ref={dialogRef}
      className="kit-diagram-explorer"
      aria-labelledby={`${scope}-title`}
      aria-describedby={`${scope}-help`}
      onCancel={(event) => {
        event.preventDefault()
        if (selected) interaction.current?.clear()
        else onClose()
      }}
    >
      <header className="kit-diagram-explorer-header">
        <h2 id={`${scope}-title`}>Explore diagram</h2>
        <div className="kit-diagram-explorer-toolbar" role="group" aria-label="Diagram controls">
          <button type="button" onClick={() => controls.current?.fit()}>
            Fit
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            disabled={scale <= 1.001}
            onClick={() => controls.current?.zoomOut()}
          >
            −
          </button>
          <output aria-label="Zoom level" aria-live="off">
            {Math.round(scale * 100)}%
          </output>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={scale >= 3.999}
            onClick={() => controls.current?.zoomIn()}
          >
            +
          </button>
          <button type="button" data-diagram-close onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <div ref={viewportRef} className="kit-diagram-explorer-viewport" role="group" aria-label="Diagram viewport">
        {/* Only the allowlisted SVG from diagram-svg crosses this boundary. */}
        <div ref={canvasRef} className="kit-diagram-explorer-canvas" />
      </div>
      <p id={`${scope}-help`} className="kit-diagram-explorer-help">
        Scroll or pinch to zoom. Drag or use arrow keys when zoomed. Select a node to see its connections.
      </p>
      <p className="kit-diagram-explorer-status" role="status" aria-label="Diagram selection" aria-live="polite">
        {announcement || 'Select a node to explore. Escape clears selection, then closes.'}
      </p>
    </dialog>
  )
}
