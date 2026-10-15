# 0070: Notices and files leave through the owner's own tools

Accepted 2026-10-15 with the owner. Amends ADR 0041 (Tell me's copies) and ADR 0021 (the `notify` power); part of the
plan that removes the Telegram channel. Builds on ADR 0066 (Notify me via) and ADR 0063 (no server-specific code).

## Context

Two things left goblin only through the Telegram channel. A routine's notice could be copied to the owner's Telegram
DM (`tellMe.telegram`), and an agent app's `notify` power sent the owner a Telegram message. Both called mygram's send
tool by name, into its `dm` chat, with Telegram's HTML escaping. The channel is going, and goblin names no server.

ADR 0066 gave the owner **Notify me via**: one connection's tool, with an argument template whose whole values may be
`{{text}}` and `{{operationId}}`. It was only a saved setting.

A third thing had no way out at all. MCP has no client-to-server upload, so the agent could not hand one of the
owner's files to a server, for example a photo to send to their chat. The standard way to give a server a file is a URL
in a tool's arguments, which a server such as mygram's `media_send` fetches.

## Decision

**A notice's copy goes through Notify me via.** Tell me's second switch is `tellMe.copy` ("Also send to <label>").
A notice of a routine with it, while a sink is set, carries its words, frozen when it is claimed. The routines' sweep
sends each copy through the sink: the template filled with the words and a stable operation id
(`notice-<digest of the notice id>`), as goblin's own call under the owner's grant of the tool (`caller: 'model'`, so a
tool set to Ask first refuses it). The words are sent as written: the server formats them, and goblin escapes nothing.

- The first attempt freezes the sink's revision (when it was set and a digest of what it says). A sink changed or
  cleared since suppresses the copy, so it never goes somewhere the owner did not choose for it.
- Resident authority and the sink are checked again right before the call leaves.
- Losing either, a tool set to Ask first or a server's refusal suppresses the copy; any other failure is tried again
  with backoff and fails after five attempts or fifteen minutes. The server's receipt is kept apart from acceptance.
- **Echo rule:** a notice of an event from the sink's own connection gets no copy, at its claim or at its first attempt.
- The UI offers the switch only while a sink is set, and says where to set one otherwise.

**The `notify` power sends through Notify me via** under the same template, checks and caps (1,000 characters, ten a
day per app). With no sink, a sink that changed, a tool that may not send or a refusal, the app's own error says so.

**`file_link` hands one owner file to a server as a short-lived URL.** The agent's tool answers
`{ url, expiresAt, name, mimeType, size }` for one existing file, under current resident authority.

- The URL is on goblin's own origin: `/files/link/<token>/<name>`.
- The token is an HMAC over the user, the file's path and when it expires, at most fifteen minutes away. Its key is
  derived from `CREDENTIAL_KEY` for this purpose only.
- The Worker checks the token in constant time before any agent wakes. It asks only the agent the token names, through
  the internal API, for that file. The agent reads it as the owner's own download does, under current resident
  authority.
- The answer is GET only: the bytes, their type, `Content-Disposition: attachment`, `Cache-Control: no-store`, and no
  cookie needed. Anything else is a 404, and the lines it writes hold no content and no token.
- Making a link sends nothing. Passing it to a tool is that tool's call, under its own grant and Ask first.

## Consequences

- Telegram is no longer special for notices or apps: a copy and an app's message go wherever Notify me via points, a
  Source's reply template copied in Settings included.
- The notice outbox keeps its columns (`telegram_*` in SQL, `copy*` in Drizzle) until the migrations are squashed. Its
  connection column now holds the sink's frozen revision.
- A routine saved with `tellMe.telegram` no longer decodes; dev holds test data and is reset with the release.
- Anyone who has a file link can fetch that file until it expires. The link is meant for one server's fetch, and it
  shows the file's path in its token.
- A link to a file that is replaced before it is fetched serves the file as it is then; one deleted is a 404.

## Rejected

- **Interpolating the notice into the template**, or escaping it for one server's format: whole values only (ADR 0066).
  A server that wants HTML says so in its own tool.
- **Copying to the channel and the sink side by side** until the channel goes: two paths would send twice.
- **A link that lasts longer, or one per file kept at a fixed address**: a fetch needs minutes, and a lasting address
  would be a public share the owner did not make.
- **Uploading the bytes in a tool argument (base64)**: models copy them badly, a tool call's arguments are bounded, and
  servers do not agree on a field for it.
