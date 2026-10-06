# Kit

Read the root instructions first. Owns goblin's rich blocks: Mermaid diagrams (beautiful-mermaid), charts (Recharts)
and maps (Leaflet), with the pure spec parsers they share. One implementation serves the chat's blocks and, later,
agent app UIs. Browser-only; no network beyond the map's tile host; specs come from model output, so parse them as
untrusted input and fall back to plain code when they do not parse. Each heavy module is its own entry so it loads
only when used.
