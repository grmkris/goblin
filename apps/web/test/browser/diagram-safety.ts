import { diagramLinks } from '../../../../packages/kit/src/diagram-graph.ts'
import { diagramSvg } from '../../../../packages/kit/src/diagram-render.ts'
import { sanitizeDiagramSvg } from '../../../../packages/kit/src/diagram-svg.ts'
import { diagramNodes, highlightDiagram } from '../../../../packages/kit/src/diagram-selection.ts'

const graphs = [
  'graph LR\n A --> B\n C --> D',
  'stateDiagram-v2\n [*] --> Idle\n Idle --> Running',
  'sequenceDiagram\n participant A as Alice\n participant B as Bob\n A->>B: Hello\n B->>A: Reply',
  'classDiagram\n Animal <|-- Dog\n class Animal {\n +name: String\n }',
  'erDiagram\n PERSON ||--o{ ORDER : places',
]
const others = [
  'xychart-beta\n x-axis [Jan, Feb]\n y-axis 0 --> 10\n bar [3, 7]',
  'pie title Pets\n "Dogs" : 40\n "Cats" : 30',
  'gantt\n dateFormat YYYY-MM-DD\n section A\n Task :a1, 2026-01-01, 3d',
  'mindmap\n  root((goblin))\n    Topics\n    Personas',
]

type Check = (condition: boolean, name: string) => void

/** Pele's drawing of `source`, through the allowlist, placed in `container`. */
async function drawn(container: HTMLDivElement, source: string, label: string): Promise<SVGSVGElement | undefined> {
  const raw = await diagramSvg(source)
  const safe = raw === undefined ? undefined : sanitizeDiagramSvg(raw, label)
  container.replaceChildren(...(safe === undefined ? [] : [safe]))
  return safe
}

async function checkGraphs(container: HTMLDivElement, check: Check) {
  for (const [index, source] of graphs.entries()) {
    const svg = await drawn(container, source, `graph ${index}`)
    check(svg !== undefined, `sanitize graph ${index}`)
    if (svg === undefined) throw new Error('SVG missing')
    const links = await diagramLinks(source)
    check(links !== undefined && links.length >= 1, `graph ${index} links from the model`)
    const nodes = diagramNodes(svg)
    check(nodes.length >= 2, `graph ${index} selectable nodes`)
    const first = nodes[0]
    if (first === undefined || links === undefined) throw new Error('node missing')
    check(highlightDiagram(svg, links, first.id) >= 1, `graph ${index} neighbours`)
    check(first.element.classList.contains('kit-diagram-selected'), `graph ${index} selected`)
    check(svg.querySelector('.pele-edge.kit-diagram-related') !== null, `graph ${index} edge related`)
    highlightDiagram(svg, links, undefined)
    check(svg.querySelector('.kit-diagram-dimmed, .kit-diagram-selected') === null, `graph ${index} clear`)
  }
  for (const [index, source] of others.entries()) {
    const svg = await drawn(container, source, `other ${index}`)
    check(svg !== undefined, `draw other kind ${index}`)
    check((await diagramLinks(source)) === undefined, `other kind ${index} has no graph`)
  }
}

async function checkModelText(container: HTMLDivElement, check: Check) {
  check(
    (await diagramSvg('graph LR\n A --> B\n style A fill:url(https://example.invalid/paint.svg#p)')) === undefined,
    'model external paint refused',
  )
  const tagged = await drawn(
    container,
    'graph LR\n A["<b>bold</b><img src=x onerror=alert(1)>"] --> B\n click A "https://example.invalid" "t"\n click B call alert(1)\n classDef hidden fill:#f00\n class B hidden',
    'tagged',
  )
  check(tagged !== undefined, 'model markup drawn')
  check(container.querySelector('img, a, [onerror], [href]') === null, 'model HTML, links and callbacks inert')
  check(!container.innerHTML.includes('example.invalid'), 'model link target dropped')
  check(container.querySelector('.hidden') === null, "model classes never become the page's")
  check(tagged?.getAttribute('aria-label') === 'tagged', 'drawing named for assistive technology')
}

function checkHostile(container: HTMLDivElement, check: Check) {
  const hostile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="pele page-class" viewBox="0 0 100 100" onload="alert(1)" role="img" style="--_fg:var(--pele-fg,#000);--_x:url(https://example.invalid/v);--bg:red;max-width:100%">
      <style>@import url('https://example.invalid/font'); body{color:red}</style>
      <script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>
      <image href="https://example.invalid/a"/><use xlink:href="https://example.invalid/a#b"/>
      <defs><marker id="arrowhead"><path d="M0 0 L1 1"/></marker></defs>
      <g class="pele-node foreign" data-id="A" data-label="x" id="A" role="button" onclick="alert(1)">
        <rect width="20" height="20" fill="url(relative.svg#p)" stroke="u&#92;72l(https://example.invalid/p)" style="fill:url(https://example.invalid/p);stroke:var(--_l);position:fixed"/>
        <path d="M0 0 L10 10" marker-end="url(#arrowhead)"/><text>&lt;script&gt;literal&lt;/script&gt;</text>
      </g><svg><rect width="1" height="1"/></svg></svg>`
  const safe = sanitizeDiagramSvg(hostile, 'hostile')
  check(safe !== undefined, 'hostile SVG parsed')
  container.replaceChildren(...(safe === undefined ? [] : [safe]))
  check(
    container.querySelector('script, style, foreignObject, image, use, a, defs, marker') === null,
    'active and referencing SVG elements removed',
  )
  check(container.querySelectorAll('svg').length === 1, 'nested SVG removed')
  check(
    !container.innerHTML.includes('example.invalid') && !container.innerHTML.includes('relative.svg'),
    'all external references removed',
  )
  check(
    container.querySelector('[onload], [onclick], [href], [xlink\\:href], [marker-end]') === null,
    'event, href and marker attributes removed',
  )
  check(container.querySelector('[id], [data-label]') === null, 'no ids or foreign data on the page')
  check(
    container.querySelector('g[role]') === null && safe?.getAttribute('role') === 'img',
    'only the root keeps a role',
  )
  check(container.querySelector('text')?.textContent === '<script>literal</script>', 'labels remain literal text')
  check(
    container.querySelector('.foreign, .page-class') === null && container.querySelector('.pele-node') !== null,
    "only Pele's classes kept",
  )
  const style = `${safe?.getAttribute('style') ?? ''};${container.querySelector('rect')?.getAttribute('style') ?? ''}`
  check(
    style.includes('--_fg') && style.includes('var(--_l)') && style.includes('max-width'),
    "Pele's variables and sizing kept",
  )
  check(
    !style.includes('--bg') && !style.includes('--_x') && !style.includes('position'),
    'other variables and properties removed',
  )
  check(sanitizeDiagramSvg('<svg><', 'invalid') === undefined, 'malformed SVG rejected')
}

/** The inline boundary and the explorer's graph, on Pele's real output and a hand-written hostile SVG. */
export async function checkDiagramSafety(): Promise<string[]> {
  const checks: string[] = []
  const check: Check = (condition, name) => {
    if (!condition) throw new Error(`SVG acceptance failed: ${name}`)
    checks.push(name)
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  try {
    await checkGraphs(container, check)
    await checkModelText(container, check)
    checkHostile(container, check)
    return checks
  } finally {
    container.remove()
  }
}
