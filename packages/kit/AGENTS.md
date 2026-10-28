# Kit

Read the root instructions first. Owns goblin's rich blocks: Mermaid diagrams (Pele, ADR 0129), charts (Recharts)
and maps (Leaflet), with the pure spec parsers they share. One implementation serves chat and agent app UIs. Each
heavy module is its own entry so it loads only when used. Charts, maps and diagrams render in the browser; the app's server render check uses stand-ins for them.

No network beyond the map's tile host; specs come from model output, so parse them as untrusted input and fall back
to plain code when they do not parse. Keep text inert, frames responsive to pane width and the theme's chart tokens.

Every diagram is one inline drawing: Pele under the fixed options in `src/diagram-render.ts`, never options a diagram
supplies, through the passive SVG allowlist in `src/diagram-svg.ts`, the only inline boundary (the main app has no
CSP): no network, callbacks, links, ids, `<style>` or classes but Pele's. The theme reaches it through `--pele-*` in
`kit.css`. Exploration uses a native dialog, Panzoom and a graph kind's edges from Pele's model (`src/diagram-graph.ts`).
`interactive={false}` draws without the explorer. Browser acceptance lives in `apps/web/test/ui-diagram.ts`; build the
app runtime first to cover its actual opaque-frame bundle.
