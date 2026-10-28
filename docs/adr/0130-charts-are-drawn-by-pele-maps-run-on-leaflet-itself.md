# ADR 0130: Charts are drawn by Pele, maps run on Leaflet itself

Status: Accepted 2026-10-28 with the owner. Amends ADR 0023: Pele replaces Recharts for ```chart blocks, which lose
area and stacked charts, and a kit-owned wrapper replaces react-leaflet for ```map blocks. Amends ADR 0021: agent-app
views no longer import `recharts` or `react-leaflet`.

## Context

- **Charts were Recharts** (ADR 0023). The chart spec (line, bar, area or pie, one category key, up to five series and
  500 rows) drew through a general charting library built on d3. That was the heaviest block:
  - 113 KB gzip of client code on a page with a chart, where a Pele diagram (ADR 0129) is 22 KB;
  - about 1 MB in the Worker's server bundle;
  - a 588 KB frame bundle for agent apps.
- **Pele already draws charts.** Its Mermaid `xychart` and `pie`:
  - draw bars and lines, grouping several bar series side by side;
  - name series in a legend (`line "Revenue" [..]`) and title the value axis;
  - colour each series and slice through `--pele-series-N`, which goblin's tokens can set.
- **What Pele cannot draw.** Mermaid's chart grammar has no area series and no stacking, and the drawing is static: no
  hover values.
- **Maps went through react-leaflet**, whose licence is Hippocratic-2.1: ethical-use restrictions, not an OSI licence.
  NOTICE.md had to warn about it. Leaflet itself is BSD-2 and maintained.
- **Lighter map engines were considered and declined:**
  - pigeon-maps (10 KB gzip): its last commit was in December 2024;
  - Leaflet 2's ES modules: they do not tree-shake below 39 KB;
  - MapLibre: needs WebGL and workers, which ADR 0023 already ruled out for app frames;
  - a hand-written tile map: 40 KB saved on a block that is rarely drawn, at the cost of owning map interaction.

## Decision

- **Charts are Pele's drawings.**
  - `chartSource` (`packages/kit/src/chart.tsx`) writes a spec as Mermaid: an `xychart` with one quoted category per
    row, each series as `bar` or `line` named by its label, and the unit as the value axis' title. A pie is the first
    series' positive values by category.
  - Labels are quoted, with a quote mark as `#quot;`. Numbers are plain decimals, since Mermaid refuses exponents. A
    missing or non-numeric value draws as 0, since a series has a value at every row.
  - The drawing goes through the same `PeleDrawing` and passive allowlist as diagrams (ADR 0129), at a larger source
    bound (100,000 characters), with Pele's options still goblin's.
  - The chart module registers only Pele's `xychart` and `pie` renderers, so a chart loads no other kind.
  - `kit.css` sets `--pele-series-1…10` to `--chart-1…5` in turn, so charts follow the theme without a redraw.
  - `type` is `line`, `bar` or `pie`; `area` and `stacked` leave the spec, so a spec that names them is refused and
    shows as code. The persona's fence guidance says so.
  - `Chart` takes an optional `fallback`, which a source Pele does not draw shows.
- **Maps run on Leaflet itself.**
  - `MapView` (`packages/kit/src/map.tsx`) makes a Leaflet map in an effect: tiles, lines, circle markers and tooltips.
    It fits the view or sets its center and zoom, and removes the map on unmount.
  - The canvas is keyed by the spec's content, so a changed spec is a new map.
  - A label reaches Leaflet's tooltip as a text node, never as a string, which Leaflet would read as HTML.
- **Agent apps.**
  - Views import `@goblin/kit/chart`, `@goblin/kit/map` and `leaflet`; `recharts` and `react-leaflet` leave the import
    allowlist and the frame bundles.
  - goblin is greenfield until launch, so there is no compatibility shim: a release that imported them fails its next
    render check, and the agent rewrites that view (with SVG or `leaflet` for what the kit does not draw).
- `recharts`, `react-leaflet` and `@react-leaflet/core` leave the repository, and NOTICE.md loses the Hippocratic
  licence.

## Consequences

- A chart page loads Pele's two chart renderers instead of Recharts. The agent-app `charts.js` is 73 KB raw (30 KB
  gzip), down from 588 KB, and `maps.js` 228 KB, down from 240 KB.
- Charts lose area series, stacking and hover values. An area chart becomes a line.
- The browser acceptance (`apps/web/test/ui-diagram.ts`) checks the drawings:
  - a bar and a pie chart are Pele's drawings, with their named series and unit;
  - a map draws its markers and line;
  - a marker label written as markup stays text.

  Map tiles are answered locally and counted apart from any other request, which must still be none.
