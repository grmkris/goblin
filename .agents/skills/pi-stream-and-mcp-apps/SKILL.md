---
name: pi-stream-and-mcp-apps
description: Change how the browser follows a chat (its AG-UI stream, the reader, the reducer, reconnect) or the sandboxed MCP Apps host.
---

# Conversation stream and MCP Apps in goblin

A chat is one stream of AG-UI 1.0 events the agent serves to every reader connected to it, the same profile third
parties read ([chat streams](../../../docs/architecture/streams.md), ADRs 0109 and 0110): `GET
/api/conversations/:id/stream`, server-sent events, each connection opening with the chat's snapshots. The browser
connects with `fetch` (`chatStream` and `readEvents` in `lib/event-streams.ts`, which holds the transports outside the
typed client) and `lib/agui/reader.ts` reads it live, connecting again for a fresh opening whenever it ends.
`lib/agui/reducer.ts` folds the events into the `ConversationProjection` the transcript draws; `lib/agui/messages.ts`
maps AG-UI messages to `ChatMessage`s (`lib/chat-messages.ts`) once per message, keeping the transcript's ids
(`<entry>:<index>`) from `metadata.goblin.entryId`, and decodes goblin's marks and activities with their contract
schemas. Older pages come from the history query, already AG-UI messages in the same mapping. `lib/conversation-parts.ts`
folds the messages into render parts (the `Part` types are in `lib/parts.ts`): each tool result joins the call that
asked for it, with a lifecycle state; the entries the app writes itself (thread heads, Persona asks and answers, Topic
briefs, Delegate results, notices) arrive as activities and Persona-marked assistant messages, and entries a later
entry omits (`omits`) are hidden. `components/parts/registry.tsx` picks the renderer for each part. A thread opens in
the thread panel beside its channel as the live thread itself (`components/shell/thread-panel.tsx`), never a copy: it
starts at its fork entry and never shows inherited history. The channel and the panel follow through the shared stream
pool (`lib/stream-pool.ts`, one reader per conversation, capped, suspended off screen); never open a second reader for
a conversation outside it.

- Assistant figures use `MessageText` → `ChatMarkdown` (Streamdown) → `RichBlock` and lazy kit entries for Mermaid,
  chart and map fences. Keep open streaming fences, invalid specs and drawing failures as code; Streamdown says which
  block's fence is still open. Keep its renderers plain (`PLAIN`) and its rehype plugins explicit. Snapshots name when they were true. Agent-app views share the kit through its import allowlist and frame
  bundles. Figures are read-only and grant no app power. Verify light/dark, narrow chats and reduced motion.
- Complete `openui` fences share `RichBlock` and the lazy `parts/openui/` interpreter (ADR 0074). Keep its grammar
  bounded and its fields local. Buttons submit only visible labels and mounted form values through `ReplySend` to
  `useConversation.send`; no hidden action, network provider or grant. Quoted and closed chats disable controls.
  Keep the runtime grammar (`pi/reply-ui.ts`) and browser library in step. Verify with `test/ui-openui.ts` and the
  public playground's built browser test. Preserve the inspector patch and `publishObservability={false}`.
- A send is AG-UI's `RunAgentInput` (ADR 0111, "Driving a chat" in the profile): the web builds it with the contracts'
  `runInput` and `threadStart` at the mutation (`conversations/queries.ts`), never by hand, and reads the 202 receipt;
  the chat's stream shows the turn. `Accept: text/event-stream` makes the endpoint answer that send's own run instead
  (`streams/run.ts` `RunFollow` over a watch of its own, `layers/run-streams.ts`): the run that took the input under
  the send's `runId`, no children, its own user message left out, only questions as interrupts, and an ask of
  Personas as a run of its answers. Hold it to `@ag-ui/client`'s `verifyEvents` (`test/streams/run.test.ts`,
  `run-streams-case.ts`); the web does not use it.
- The stream is authoritative. Do not keep a second transcript. Something the UI needs of an entry that the stream
  does not carry is added to `metadata.goblin` or STATE on the server (`apps/runtime/src/streams/`), for every reader,
  never read from Pi's entries in the browser.
- A chat's children (a Persona's fork, a subagent) stream into it under AG-UI's subagent attribution: `subagentRunId`
  is the child's chat, `SUBAGENT_STARTED` and `SUBAGENT_FINISHED`/`SUBAGENT_ERROR` bound its work, and its answer is the
  chat's own message naming it in `metadata.goblin.subagentRunId`. The runtime translates a child over its own cursor
  (`streams/children.ts`, kept in each reader's) and follows it with a watch of its own (`streams/child-follow.ts`:
  Personas by `invocations.changed`, subagents by `conversations.changed`) while its parent has readers. Every reader,
  an installed app included, gets the child's work in full. The reducer keeps a child's events with it
  (`ConversationProjection.children`), never in the transcript; the rows after the transcript
  (`components/shell/answering.tsx`) show who works from it, and a Persona waiting its turn from the workspace feed. A
  connection's opening starts the children working then; never infer a child from Pi's entries in the browser.
- Queued inputs and what they say come from STATE `/queue` (the producer reads `InboxDoc`). Render the queue above both
  composers, outside the transcript and turn map. Normal Send stays a follow-up; unchanged failed drafts reuse their
  operation IDs. Row removal uses the owner DELETE queue API and disables only that row while pending; the stream shows
  the queue without it. Keep failures visible and report an already-started outcome without invoking Stop.
- The conversation list and activity come from the workspace feed (`/api/workspace/events`, opened by
  `components/workspace-feed.tsx` and kept by `lib/workspace/`): one stream per tab, a fresh snapshot on every
  reconnect, written into the Query cache as one slice per kind (`['workspace', slice]`) that components read through
  the hooks in `lib/workspace/hooks.ts` with a `select`. The tab reads each conversation, activity, App and change on
  its own and skips one it cannot read (`lib/workspace/decode.ts`), so a server newer than the tab never stops the
  feed; only a frame of another shape reconnects. Never refresh the list after a run, and never hold feed data in a
  second store.
- Every connection opens afresh (its `MESSAGES_SNAPSHOT` resets the reducer): a connection the server ended after its
  events connects again at once, a dropped or 45-seconds-silent one after a backoff (`lib/reconnect.ts`); a 404 or 403
  stops, a 401 goes to sign-in (`failedOutside`). Never add offsets, `Last-Event-ID` or a second transcript to resume
  with. Verify with `test/agui-reader.test.ts`, the reducer against the runtime's goldens (`test/agui-reducer.test.ts`,
  the `fork` golden for a child), and the browser fixtures `test/ui-channel.ts` and `test/ui-queue.ts`, which serve
  AG-UI as server-sent events (`test/agui-route.ts`). The producer is held by
  `apps/runtime/test/streams/producer.test.ts`, a child's translation by `children.test.ts` and, in workerd,
  `streams-case.ts` and `streams-children-case.ts`.
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
  Rows render without `content-visibility`, so measurements are real heights. Until the stream's opening is read the
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
