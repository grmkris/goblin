# Kit

Read the root instructions first. Owns goblin's rich blocks: Mermaid diagrams (beautiful-mermaid), charts (Recharts)
and maps (Leaflet), with the pure spec parsers they share. One implementation serves the chat, Home notes and agent
app UIs. Each heavy module is its own entry so it loads only when used. Charts, maps and diagrams render in the
browser; the app's server render check uses stand-ins for them.

No network beyond the map's tile host; specs come from model output, so parse them as untrusted input and fall back
to plain code when they do not parse. Keep text inert, frames responsive to pane width and the theme's chart tokens.
