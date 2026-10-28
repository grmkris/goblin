const SVG_NS = 'http://www.w3.org/2000/svg'
const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
])
const ATTRIBUTES = new Set([
  'class',
  'style',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'dx',
  'dy',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-anchor',
  'dominant-baseline',
  'data-id',
])
/** Only the drawing's root names what it is to assistive technology. */
const ROOT_ATTRIBUTES = new Set(['role', 'aria-roledescription'])
const STYLE_PROPERTIES = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'color',
  'direction',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'rx',
  'max-width',
  'height',
])
/** Pele's own variables: the page's `--pele-*` theme, which the root reads into its private `--_*` ones. */
const VARIABLE = /^--(?:pele-|_)[\w-]+$/u
const CLASS = /^pele(?:-[a-z0-9-]+)?$/u

/** A deliberately small CSS vocabulary: no escapes, URLs, declarations or variables other than Pele's. */
function safeValue(value: string): boolean {
  if (!/^[\w\s#.,()%+'"-]+$/u.test(value) || /(?:url|image|expression)\s*\(/iu.test(value)) return false
  for (const variable of value.matchAll(/var\(\s*(--[\w-]+)/gu)) {
    if (!VARIABLE.test(variable[1] ?? '')) return false
  }
  return true
}

function safeStyle(style: CSSStyleDeclaration): string {
  const result: string[] = []
  for (const property of style) {
    const value = style.getPropertyValue(property)
    if ((STYLE_PROPERTIES.has(property) || VARIABLE.test(property)) && safeValue(value))
      result.push(`${property}:${value}`)
  }
  return result.join(';')
}

function safeAttribute(name: string, value: string): string | undefined {
  if (name === 'class')
    // A diagram's own `classDef` names (`hidden`, `fixed`) would be the page's classes once inline: only Pele's stay.
    return value
      .split(/\s+/u)
      .filter((item) => CLASS.test(item))
      .join(' ')
  if (name === 'style') {
    const style = document.createElement('span').style
    style.cssText = value
    return safeStyle(style)
  }
  if (name === 'data-id') return value
  return safeValue(value) ? value : undefined
}

function copyAttributes(element: Element, safe: Element, root: boolean): void {
  for (const attribute of element.attributes) {
    const allowed = ATTRIBUTES.has(attribute.name) || (root && ROOT_ATTRIBUTES.has(attribute.name))
    if (!allowed || attribute.namespaceURI !== null) continue
    const value = safeAttribute(attribute.name, attribute.value)
    if (value !== undefined) safe.setAttribute(attribute.name, value)
  }
}

function copyElement(element: Element, root: boolean): Element | undefined {
  if (element.namespaceURI !== SVG_NS || !ELEMENTS.has(element.localName)) return
  const safe = document.createElementNS(SVG_NS, element.localName)
  copyAttributes(element, safe, root)
  for (const child of element.childNodes) {
    const safeChild = copyChild(child)
    if (safeChild !== undefined) safe.appendChild(safeChild)
  }
  return safe
}

function copyChild(child: Node): Node | undefined {
  if (child instanceof Element) return child.localName === 'svg' ? undefined : copyElement(child, false)
  if (child.nodeType === Node.TEXT_NODE) return document.createTextNode(child.textContent ?? '')
  return
}

/**
 * Only Pele's passive SVG vocabulary may cross the inline boundary (ADR 0129): shapes, text and Pele's classes,
 * variables and data ids. The drawing is rebuilt in a detached tree, so no raw attribute, style, link, script or id
 * from the source reaches the page; `label` names it for assistive technology.
 */
export function sanitizeDiagramSvg(source: string, label: string): SVGSVGElement | undefined {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS || parsed.querySelector('parsererror') !== null) return
  const safe = copyElement(root, true)
  if (!(safe instanceof SVGSVGElement)) return
  safe.setAttribute('aria-label', label)
  return safe
}
