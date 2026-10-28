import { renderAsync } from 'pele/lazy'
import { DIAGRAM_OPTIONS } from './pele-options.ts'

export { DIAGRAM_OPTIONS }

/** A Mermaid source's first word, the diagram's kind as its author wrote it (`graph`, `sequenceDiagram`). */
export const diagramKind = (source: string): string => source.trim().split(/\s/u, 1)[0] ?? 'diagram'

/** Pele's SVG for a Mermaid source, or nothing when it does not draw (unknown kind, invalid, over the bounds). */
export async function diagramSvg(source: string): Promise<string | undefined> {
  try {
    return (await renderAsync(source, DIAGRAM_OPTIONS)).svg
  } catch {
    // expected: model-written Mermaid that does not parse shows as code (the caller's fallback)
    return undefined
  }
}
