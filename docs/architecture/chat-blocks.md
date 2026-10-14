# Chat blocks

## Chat blocks

The agent's replies draw fenced blocks (ADR 0023): ```mermaid diagrams, and ```chart and ```map with a
JSON spec (`ChartSpec`, `MapSpec` in `packages/kit/src/specs.ts`). `MessageText`
(`components/parts/text-part.tsx`) hands such a block to `RichBlock` (`components/parts/blocks.tsx`), which loads that kind's module from `@goblin/kit`
on first use and shows the plain code block whenever the source does not parse or drawing fails. While a reply
streams, the block whose fence is still open stays code: Streamdown parses each block on its own and says which one
that is (`useIsCodeFenceIncomplete`). A diagram is beautiful-mermaid's SVG as an
`<img>` data URI with the theme's tokens resolved to concrete colours, so nothing in it runs or loads; it redraws when
the theme changes. **Explore diagram** opens the kit's native dialog with Panzoom 4.6.2, fitted 1–4× zoom,
bounded dragging/pinch gestures and keyboard node selection. `diagram-svg.ts` rebuilds a passive, allowlisted SVG,
scopes the renderer CSS and namespaces marker IDs; model callbacks, links, font imports and external paint URLs
are discarded before inline insertion. `Diagram` defaults to interactive; `interactive={false}` keeps only the image.
The dialog stays inside an agent app's frame. Charts are Recharts in the five `--chart-*` tokens; maps are Leaflet over
OpenStreetMap's raster tiles, quieted to the theme by a CSS filter, the one host a block fetches from. The persona prefers ordinary Markdown and describes the supported fence grammars; Telegram shows drawn fences as code.
