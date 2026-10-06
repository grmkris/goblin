# Kit

Read the root instructions first. Owns goblin's rich blocks: Mermaid diagrams (beautiful-mermaid), charts (Recharts)
and maps (Leaflet), plus the curated mdxcn figures, with the pure spec parsers they share. One implementation serves
the chat's blocks and agent app UIs. Charts, maps and diagrams render in the browser; mdxcn also runs in the app's
server render check. No network beyond the map's tile host; specs come from model output, so parse them as
untrusted input and fall back to plain code when they do not parse. Each heavy module is its own entry so it loads
only when used.

mdxcn's MIT notice and upstream revision live in `vendor/mdxcn/`. Keep the five data forms bounded, text inert,
frames responsive to pane width, and entrance animations disabled under reduced motion. Do not add an MDX compiler.
