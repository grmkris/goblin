# Files

## Files

The owner's files (ADR 0022, `files/store.ts`): `@cloudflare/shell`'s Workspace over the agent's SQLite, with files
over 128 KiB in the stage's R2 bucket under `agents/<userId>/`. A deployment without the bucket
(`GOBLIN_LARGE_FILES=off`, ADR 0064) keeps every file in SQLite and refuses one over 128 KiB as too large; an app's
files likewise. `/uploads` holds what the owner uploaded; `/agent` is where the agent writes. The owner reads and
writes both through `/api/files`; the agent reads both and writes only `/agent`, with `files_list`, `files_read` (text, 48 KB a page), `files_write`, `files_delete` and `file_link` (`pi/files.ts`, the
`goblin.files` extension, on main and threads; subagents and routine runs keep the tools they are handed). Limits: 25 MiB a file, 512 MiB and 2,000 files in all, checked before
each write; a body longer than it declared stores nothing. The composer's paperclip uploads to
`/uploads/<local date>/` under a name that replaces nothing (`lib/files.ts`), and the message carries the paths: Pi
gets the owner's words, then one block listing each file's path, name, size and type, then any App context
(`pi/content.ts`). The web reads that block back into chips under the message (`lib/app-context.ts`), only when every
block after the words is one it knows. Deleting the account deletes the R2 prefix before the object's storage.

goblin itself writes under `/agent/received/` ([ADR 0065](../adr/0065-files-from-mcp-content.md), `mcp/content/materialize.ts`):
the files a model's MCP call hands over in its result (links, embedded blobs and long text, audio), in a folder per
connection (its label, slugged) and day (UTC), under a name that replaces nothing there, within the same limits (a file
over one, such as over 128 KiB without the bucket, is a note the model reads instead). The model reads each file's
path, name, type and size in the block's place; the call shows each as a chip
(`ReceivedFiles` in `attachments.tsx`, read from the result's `received`). Outbound MCP describes how they are fetched.

## File links

MCP has no way for a client to upload a file to a server; a server that takes one (sending a photo or a document to
the owner's chat) takes an https URL in its arguments and fetches it. `file_link({ path })` ([ADR
0070](../adr/0070-notices-and-files-leave-through-the-owners-tools.md), `files/link.ts`) answers
`{ url, expiresAt, name, mimeType, size }` for one existing owner file, under current resident authority. Making a link
sends nothing: passing it to a tool is that tool's call, under its own grant and Ask first.

- **The URL** is `/files/link/<token>/<name>` on the deployment's own origin (`APP_URL`), which the web Worker forwards
  to the runtime's. The name is for a server that names what it fetched by its URL; the route ignores it.
- **The token** (`files/link-token.ts`) is `<claims>.<mac>`: the claims (`{ u, p, e }`: the user, the file's path and
  when it expires, at most fifteen minutes on) as base64url JSON, and their HMAC-SHA-256 under a key derived from
  `CREDENTIAL_KEY` with HKDF for this purpose only (`goblin/files/link`, `runtime/purpose-key.ts`, as the Events
  webhook's route token is derived for its own).
- **The route** (`http/worker.ts`) answers GET only. It checks the token (the MAC in constant time, then the expiry)
  before any agent wakes, then asks the agent the token names, never one a request names, for that path through the
  internal API (`GET /internal/files/linked`, `inbound/client.ts` `linkedFile`). The agent reads the file as the owner's
  own download does (`Files.read`), under current resident authority, and logs a `file-link` line with its size only.
  The answer is the bytes with their type, `Content-Disposition: attachment`, `Cache-Control: no-store`, `nosniff` and
  a sandboxing CSP, and needs no cookie. A bad, expired or tampered token, any other method and anything the agent
  will not serve (the file is gone, authority lapsed) are 404s; the edge's failure line names the route template, never
  the token.
