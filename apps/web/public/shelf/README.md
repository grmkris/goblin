# Shelf icons

The square marks the shelf of suggested servers shows beside each name (`apps/runtime/src/mcp/servers/shelf.ts` names
them as `icon: '/shelf/<id>.svg'`). They are the deployment's own files, so showing the shelf asks no provider's host
for anything. A server without one shows its initial on a plate instead.

Each file is a 40×40 tile: the brand's colour as the plate, its glyph from [Simple Icons](https://simpleicons.org)
16.35.0 (CC0-1.0) in white, or black on a light brand colour, with the source slug and colour in the file's first line.
The marks are trademarks of their owners and identify the services goblin connects to; they are not covered by
goblin's MIT license, and each owner's brand guidelines apply.

To add one, take the glyph's path from the same Simple Icons release, keep the tile's layout, and set the entry's
`icon` in the shelf. A deployment's own `MCP_SHELF` entries may name an `icon` of their own: a square image on the
deployment's origin, or a URL the owner's browser then loads.
