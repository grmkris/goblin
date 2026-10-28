import { type RenderOptions, renderAsync } from 'pele/lazy'

/** Longer Mermaid sources stay readable code: layout runs on the page thread. */
const MAX_SOURCE = 20_000

/**
 * Pele's options, fixed by goblin and never by a diagram (ADR 0129): no links or images, so a drawing fetches and
 * navigates nothing; no icon or math callbacks, whose markup Pele inserts unfiltered; bounded source and edges, since
 * Pele has no time limit of its own.
 */
export const DIAGRAM_OPTIONS = {
  links: false,
  images: false,
  limit: MAX_SOURCE,
  maxEdges: 1000,
} as const satisfies RenderOptions

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
