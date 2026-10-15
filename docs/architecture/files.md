# Files

## Files

The owner's files (ADR 0022, `files/store.ts`): `@cloudflare/shell`'s Workspace over the agent's SQLite, with files
over 128 KiB in the stage's R2 bucket under `agents/<userId>/`. A deployment without the bucket
(`GOBLIN_LARGE_FILES=off`, ADR 0064) keeps every file in SQLite and refuses one over 128 KiB as too large; an app's
files likewise. `/uploads` holds what the owner uploaded; `/agent` is where the agent writes. The owner reads and
writes both through `/api/files`; the agent reads both and writes only `/agent`, with `files_list`, `files_read` (text, 48 KB a page), `files_write` and `files_delete` (`pi/files.ts`, the
`goblin.files` extension, on main and threads; subagents and routine runs keep the tools they are handed). Limits: 25 MiB a file, 512 MiB and 2,000 files in all, checked before
each write; a body longer than it declared stores nothing. The composer's paperclip uploads to
`/uploads/<local date>/` under a name that replaces nothing (`lib/files.ts`), and the message carries the paths: Pi
gets the owner's words, then one block listing each file's path, name, size and type, then any App context
(`pi/content.ts`). The web reads that block back into chips under the message (`lib/app-context.ts`), only when every
block after the words is one it knows. Deleting the account deletes the R2 prefix before the object's storage.

goblin itself writes under `/agent/received/` ([ADR 0065](../adr/0065-files-from-mcp-content.md), `mcp/content.ts`):
the files a model's MCP call hands over in its result (links, embedded blobs and long text, audio), in a folder per
connection (its label, slugged) and day (UTC), under a name that replaces nothing there, within the same limits. The
model reads each file's path, name, type and size in the block's place; the call shows each as a chip
(`ReceivedFiles` in `attachments.tsx`, read from the result's `received`). Outbound MCP describes how they are fetched.
