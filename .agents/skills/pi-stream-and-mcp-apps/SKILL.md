---
name: pi-stream-and-mcp-apps
description: Change how the browser follows the Pi conversation (SSE snapshot, batches, reconnect) or the sandboxed MCP Apps host.
---

# Conversation stream and MCP Apps in goblin

The browser follows committed Pi state over Server-Sent Events: `/api/conversations/:id/events` sends a snapshot of entries,
then batches, with a heartbeat. The two event streams are owner endpoints served through raw handlers
(`conversations.events`, `workspace.events`), behind the Worker's edge like the rest of the typed owner API (ADR 0038); the stream's own reads (the JSON snapshot, the queue) and every
other server read go through the typed client's factories (`conversations/queries.ts`), and a stream event only
invalidates the query keys it affects. `apps/web/src/lib/projection.ts` keeps the stream's snapshot and batches as a
projection; `lib/entry-messages.ts` and `lib/chat-messages.ts` turn its entries into messages and tool calls, and
`lib/conversation-parts.ts` folds them into render parts (the `Part` types are in `lib/parts.ts`): each tool result
joins the call that asked for it, with a lifecycle state; the entries the app writes itself (thread heads, Persona asks and answers, Topic briefs, Delegate results) are
decoded with their contract schemas, and entries a later entry's edits omit are hidden.
`components/parts/registry.tsx` picks the renderer for each part. A thread opens in the thread panel beside its
channel as the live thread itself (`components/shell/thread-panel.tsx`), never a copy: it starts at its fork entry and
never shows inherited history. The channel and the panel follow through the shared stream pool
(`lib/stream-pool.ts`, one stream per conversation, capped, suspended off screen); never open a second stream for a
conversation outside it.

- Assistant figures use `MessageText` → `ChatMarkdown` (Streamdown) → `RichBlock` and lazy kit entries for Mermaid,
  chart and map fences. Keep open streaming fences, invalid specs and drawing failures as code; Streamdown says which
  block's fence is still open. Keep its renderers plain (`PLAIN`) and its rehype plugins explicit. Snapshots name when they were true. Agent-app views share the kit through its import allowlist and frame
  bundles. Figures are read-only and grant no app power. Verify light/dark, narrow chats and reduced motion.
- Complete `openui` fences share `RichBlock` and the lazy `parts/openui/` interpreter (ADR 0074). Keep its grammar
  bounded and its fields local. Buttons submit only visible labels and mounted form values through `ReplySend` to
  `useConversation.send`; no hidden action, network provider or grant. Quoted and closed chats disable controls.
  Keep the runtime grammar (`pi/reply-ui.ts`) and browser library in step. Verify with `test/ui-openui.ts` and the
  public playground's built browser test. Preserve the inspector patch and `publishObservability={false}`.
- Pi state is authoritative. Do not keep a second transcript or invent cursor replay.
- Queue contents for Main and ordinary threads come from the owner queue API over `InboxDoc`; native snapshot/inbox
  IDs remain authoritative membership. Keep one cancellable content read in the shared stream, reject stale reads,
  retain contents on failure, and render the queue above both composers, outside the transcript and turn map. Normal
  Send stays a follow-up; unchanged failed drafts reuse their operation IDs.
  Row removal uses the owner DELETE queue API and disables only that row while pending. Keep failures visible,
  refresh through the shared stream, and report an already-started outcome without invoking Stop.
- The conversation list and activity come from the workspace feed (`/api/workspace/events`, opened by
  `components/workspace-feed.tsx` and kept by `lib/workspace/`): one stream per tab, a fresh snapshot on every
  reconnect, written into the Query cache as one slice per kind (`['workspace', slice]`) that components read through
  the hooks in `lib/workspace/hooks.ts` with a `select`. The tab reads each conversation, activity, App and change on
  its own and skips one it cannot read (`lib/workspace/decode.ts`), so a server newer than the tab never stops the
  feed; only a frame of another shape reconnects. Never refresh the list after a run, and never hold feed data in a
  second store.
- Reconnect by opening a fresh stream and starting from its snapshot; dispose the previous stream. Back off between
  attempts (`conversation-stream.ts`).
- MCP Apps are tool-associated `ui://` resources from the originating server. Render them in the sandboxed iframe
  with its CSP; validate message origin and source.
- Apps are kept per call in the runtime registry (`apps/registry.ts`, ADR 0020) and listed by the workspace feed;
  keeping or launching one grants nothing. Several live at once, one instance each (`components/apps/host.tsx`), each
  iframe in its own fixed stage (`stage.tsx`) that follows page > inline slots; moving an
  iframe in the DOM reloads the App and loses its state, so only the empty measured slots move. Stages clip to their
  slot's scrolling containers, their chat's `data-app-cover` elements and any `data-app-overlay` (the thread panel). At most six load; the least recently seen
  unloads to a stub, never one on screen (`lib/app-residency.ts`). Fullscreen is the App's page (`/a/<id>`), with goblin's composer for its conversation over the bottom edge as `data-app-cover` and what it covers told to the App as `safeAreaInsets` (ADR 0053); a server's own App lives in its own thread and loads with its tool called as the owner. Verify moving, resizing, scrolling and responsive changes with an
  actual SDK-connected iframe, plus origin binding and teardown/reconnect tests.
- An App's tool and resource calls go through the owner API to the originating server only, and need that server's
  grant: the frame (`components/apps/frame.tsx`) sends them through `apps/queries.ts` with `x-mcp-caller: app`, and an
  agent app's actions, state reads and failure reports through the same factories. No cross-server calls, no
  credentials in iframe state, browser bundles, logs or transcripts.
- Keep the plain tool-result fallback for hosts or results without an App. Unimplemented host methods stay
  unsupported.
- The transcript scrolls in `Conversation` (`components/conversation.tsx`) over the patched @shadcn/react
  MessageScroller (`patches/shadcn-react/README.md`; `bun run check:patches` proves the patch is installed). Only
  the owner's own turns are scroll anchors (`isOwnTurn` in `lib/parts.ts`); keep part ids stable across a reply's
  commit and give every row a `messageId`, because the scroller tells appends, prepends and new anchors apart by rows.
  Rows render without `content-visibility`, so measurements are real heights. While the snapshot is loading the
  transcript shows nothing, so it opens at its end.
- The turn map (`components/turn-map.tsx`, geometry in `lib/turn-map.ts`) sits in the transcript's right gutter with
  `data-app-cover`: a mark per own turn where it is, a band for what is on screen, a hover list that jumps with
  `scrollToMessage`, and an edge tab with a bottom sheet where there is no fine pointer or room. It measures turns
  without the scroller's tail spacer and draws in SVG attributes, never inline styles.
- A real browser render and a permitted App interaction are separate evidence from unit tests.

Before changing an API call, read the current [documentation](https://apps.extensions.modelcontextprotocol.io/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Main has only its transcript and composer; the single App stage follows page > inline slots. Keep frame/bridge continuity, clipping, grants and the six-instance soft cap.
