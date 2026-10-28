# ADR 0129: Diagrams are drawn inline by Pele

Status: Accepted 2026-10-28 with the owner. Amends ADR 0023: Pele replaces beautiful-mermaid, a diagram is one
sanitized inline drawing instead of an `<img>` preview with a second inline copy for its explorer, the page's tokens
theme it through CSS variables, and every Mermaid kind Pele draws is drawn.

## Context

ADR 0023 drew Mermaid with beautiful-mermaid 1.1.3:
- **Coverage:** six kinds (flowchart, sequence, class, state, ER, xychart); gantt, pie, mindmap, timeline and the rest
  stayed code.
- **Weight:** 458 KB gzip in the chat chunk and 471 KB in the agent-app frame bundle, mostly the ELK layout engine.
  Measured on goblin's fixtures on the build box, a typical flowchart took 5.5 ms, a 60-node one 37 ms, and a page's
  first diagram 202 ms.
- **Display:** its SVG was shown as an `<img>` data URI. An image cannot read the page's CSS, so the theme's tokens were
  resolved to concrete colours with `getComputedStyle` and the diagram redrawn on every theme change. The image could
  not adapt to a narrow column, and its text could not be selected, found or read aloud. The explorer parsed the same
  SVG a second time into a sanitized inline copy, so each diagram had two copies and two code paths.

Pele (Obsidian, MIT, zero dependencies; 1.12.0) renders every kind built into Mermaid 12.1 to SVG themed by CSS
variables. Measured on the same fixtures:
- **Weight:** 263 KB gzip for every kind; goblin's six graph and chart kinds come to about 112 KB, and Pele loads each
  kind's renderer on demand.
- **Speed:** a flowchart takes 0.31 ms, a 60-node one 2.5 ms, a page's first diagram 16 ms.
- **Output, across every kind:** only `svg g path rect circle polygon text tspan title`. No `<style>`, `<marker>`,
  `id`, link, image or `foreignObject`. Colour comes through `style` attributes that read `--pele-*` variables with
  defaults. Nodes carry `data-id`; edges carry an id the parsed model names.
- **Model text:** Pele escapes diagram text, ignores `click` callbacks, filters styles and refuses a `style` with a
  `url()`.
- **Gap:** a diagram's own `classDef` names (`hidden`, `fixed`) pass through as classes.

Ondine (Rust to WASM, 0.0.3) was considered and declined. It compiles diagrams ahead of time; drawing model-written
diagrams in the browser ships its WASM, 805 KB gzip for every kind, and it was a week old.

## Decision

- **One inline drawing.**
  - `Diagram` mounts Pele (`pele/lazy`'s `mountAsync`) into its figure, through `sanitize`. Pele lays the diagram out
    again for its column's width.
  - The explorer draws the same source at its natural size into its dialog, through the same allowlist. No copy passes
    from the preview.
  - `interactive={false}` is the same drawing without an explorer. The server still renders the code, and the browser
    draws.
- **The allowlist is the boundary.** The main app has no Content Security Policy, so `diagram-svg.ts` is the only thing
  between model output and the page. It rebuilds every drawing in a detached tree and keeps only:
  - the elements above, plus `ellipse`, `line`, `polyline` and `desc`;
  - geometry and paint attributes, `data-id`, and `role` and `aria-roledescription` on the root;
  - Pele's classes (`pele`, `pele-*`);
  - Pele's variables (`--pele-*`, `--_*`) and a small set of style properties;
  - values without escapes, URLs, `image()` or `expression()`.

  Ids, links, scripts, handlers, `<style>`, nested `<svg>` and a diagram's own classes never reach the page.
- **Fixed options.** goblin sets Pele's options; a diagram never does:
  - `links: false` and `images: false`, so a drawing fetches and navigates nothing;
  - no icon or math callbacks, whose markup Pele inserts unfiltered;
  - `limit: 20000` (today's bound) and `maxEdges: 1000`, since Pele has no time limit of its own.
- **Theme by variables.** `kit.css` maps goblin's tokens to Pele's variables (`--pele-fg: var(--foreground)`,
  `--pele-surface: var(--muted)`, `--pele-accent: var(--chart-1)`, the fonts and the rest). Light and dark follow the
  page with no redraw; the colour lookup and the theme hook are gone.
- **Every kind is drawn.** A graph kind (flowchart, state, sequence, class, ER) has selectable nodes in the explorer:
  - Neighbours and incident edges come from Pele's parsed model, decoded by schema, with each kind's edge ids as Pele
    draws them.
  - A model of a shape the decoder does not know gives no selection, not a wrong one.
  - Every other kind is drawn and can be zoomed and panned without inventing nodes.
- **Explorer navigation stays goblin's own.**
  - Panzoom drives the 1–4× zoom, drag, pinch, wheel, arrow keys and the zoom readout.
  - Pele's zoom covers drag, pinch and keys, but it has no event for a scale change, which the readout needs.
- **Agent apps.** The frame bundle `diagrams.js` registers every kind in one file. It is now 812 KB raw and 300 KB
  gzip, down from 1,596 KB and 471 KB. The elkjs `__require` shim in the frame build is gone.

## Consequences

- Measured on the build against the release before it (`apps/web/test/ui-bytes.ts --base 928a0a70`):
  - A chat page that draws a flowchart loads 113 KB gzip of diagram code, down from 458 KB.
  - All client JavaScript is 335 KB gzip smaller, and the Worker is 1.76 MB raw (231 KB gzip) smaller, since the
    server bundle no longer carries the renderer's lazy chunk.
  - The route preloads did not change; diagram code was already loaded on first use.
- The persona prompt names every kind. Telegram replies still show fences as code.
- A model's diagram may now be any Mermaid kind. Kinds Pele handles less well than Mermaid itself are its own to
  improve.
- Pele and its model's field names are pinned at 1.12.0. The kit's unit tests name each graph kind's edges, and the
  browser acceptance (`apps/web/test/ui-diagram.ts`) draws, selects and themes nine kinds. An upgrade that changes
  either fails there first.
- An inline drawing inherits the page's CSS. Pele styles its own shapes through attributes and variables, and the
  acceptance checks that the page's own SVG keeps its font and variables beside inline previews.
