# 0065: Files from MCP content

Accepted 2026-10-15 with the owner. Amends ADR 0022 (what writes under `/agent`: goblin itself, with the files a tool
result hands over). Part of the cleanup that makes goblin an MCP-first client that treats every server alike
(ADR 0063).

## Context

A tool result can hand media over three ways besides text and images: a `resource_link` (a URI with a name and a type),
an embedded resource (its `text` or base64 `blob`) and `audio` (base64 `data`). goblin passed text and images to the
model and wrapped every other block as `unsupportedMcpContent`, the link with its full URL, the bytes inline. The model
could do nothing with either; the transcript kept base64 it could not read and signed URLs whose signature is a
credential for as long as it lasts. Platforms hand media to clients as URLs and expect the client to fetch and keep
them, never to put the bytes in the conversation. The owner already has files (ADR 0022) the agent can write and the
owner can open.

## Decision

- **goblin keeps what a result hands over in the owner's files.** After a model's `mcp_call` completes, each link,
  embedded blob, embedded text longer than 16 K characters and audio block of its result is written with `Files.write`
  under `/agent/received/<connection label, slugged>/<YYYY-MM-DD>/<name>` (`mcp/content.ts` `materialize`); an App's
  own `ui://` resource, linked or embedded, is the Apps host's and is never kept. The name is the link's `name`, else
  its `title`, else its URI's last segment (`audio` for audio), made safe by the file path rule, given the usual
  extension of its type when it has none, and never one already in the folder. At most eight blocks of one result are
  kept, one at a time.
- **A public https link is fetched as anyone could.** No credentials: never the connection's OAuth token, never a
  cookie. The link and every redirect must be a public https address (the rule for servers the owner adds, ADR 0006,
  `mcp/endpoint.ts` `isPublicHttps`); at most three redirects; at most 25 MiB, counted as the bytes arrive and the body
  abandoned past it; thirty seconds in all. The type is the response's, else the link's.
- **A link of any other scheme is read from its own server.** `resources/read` on the same connection, under the
  owner's grant for that exact resource, as every resource read is. Without the grant the block stays a reference the
  model can name (the link without its query and fragment) with a note that the owner has not allowed reading it. An
  `http:` link, or an https link to a private address, is refused outright.
- **A block that cannot be kept is a note, never a failed call.** The model reads "could not fetch <name>: <reason>"
  (or "could not keep") in goblin's words; the rest of the result is unchanged.
- **The model reads a reference in the block's place.** `{ receivedFile: { path, name, mimeType, size } }`, inside the
  result's untrusted envelope. A kept PNG, JPEG, GIF or WebP of at most 256 KiB is also shown to it as an image when its
  Pi model takes image input, as pi-ai decides for any tool result's image.
- **A link is recorded without its query.** Wherever a result is recorded (its details in the transcript, which an App
  also launches with, and a held call's outcome), every link block loses its query and fragment, so a signed URL's
  signature is never kept, and a kept block loses its bytes. The details add `received`, goblin's own list of the files
  it kept (`ReceivedFiles`), which the web shows as file chips under the call. Telemetry carries no part of any of it
  (ADR 0024).

## Consequences

- The agent writes under `/agent` for itself now, not only when the model asks: received files count against the
  owner's 25 MiB per file, 512 MiB and 2,000 files, and a full store turns a block into a note.
- Nothing holds a SQLite transaction or a lock across a fetch; two calls at once that keep the same name in the same
  folder on the same day can still collide, and the later one replaces the earlier.
- A resource read from a server is bounded as any resource result is (1 MiB), not at 25 MiB.
- Other readers of a server's content (a later Events source reader) call the same `materialize`. A held call's result
  (ADR 0028) and a finished URL request's (ADR 0042) are not kept as files yet; their outcome only loses its links'
  queries.
- URLs inside a result's text or structured content are the server's data and are kept as they are.
