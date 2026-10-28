import type { DiagramLink } from './diagram-graph.ts'

const NODES = '.pele-node[data-id]'
const EDGES = '.pele-edge[data-id], .pele-edge-label[data-id]'

export type DiagramNode = { readonly id: string; readonly label: string; readonly element: SVGGElement }

/** Pele's nodes, labelled by the text they show; a sequence actor drawn top and bottom is two nodes of one id. */
export function diagramNodes(svg: SVGSVGElement): DiagramNode[] {
  return [...svg.querySelectorAll<SVGGElement>(NODES)].map((element) => ({
    id: element.dataset.id ?? '',
    label: element.textContent.replaceAll(/\s+/gu, ' ').trim() || element.dataset.id || 'Node',
    element,
  }))
}

/** Highlights `selected`, its neighbours by `links` and the edges between them, dimming the rest; the neighbour count. */
export function highlightDiagram(
  svg: SVGSVGElement,
  links: readonly DiagramLink[],
  selected: string | undefined,
): number {
  const incident = links.filter(({ from, to }) => selected !== undefined && (from === selected || to === selected))
  const related = new Set(incident.map(({ id }) => id))
  const neighbors = new Set(incident.flatMap(({ from, to }) => [from, to]).filter((id) => id !== selected))
  for (const { id, element } of diagramNodes(svg)) {
    element.classList.toggle('kit-diagram-selected', id === selected)
    element.classList.toggle('kit-diagram-related', neighbors.has(id))
    element.classList.toggle('kit-diagram-dimmed', selected !== undefined && id !== selected && !neighbors.has(id))
  }
  for (const edge of svg.querySelectorAll<SVGGElement>(EDGES)) {
    const linked = related.has(edge.dataset.id ?? '')
    edge.classList.toggle('kit-diagram-related', linked)
    edge.classList.toggle('kit-diagram-dimmed', selected !== undefined && !linked)
  }
  return neighbors.size
}
