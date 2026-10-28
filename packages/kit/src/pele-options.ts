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
} as const
