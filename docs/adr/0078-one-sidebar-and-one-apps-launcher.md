# 0078: One sidebar and one Apps launcher

Accepted 2026-10-16 with the owner (navigation and Apps plan, `evidence/plans/navigation-and-apps-20261016.md`). It
supersedes ADR 0036's rail and the sidebar it described, ADR 0053's servers pinned by default (`seen`, `adopt`) and its
hidden signed-out pins, ADR 0021's separate sidebar list of agent apps, and ADR 0064's "the rail has no Apps" without
agent apps. The rest of those decisions stands.

## Context

Two navigation columns sat side by side: a rail of places (Home, Threads, Activity, Tasks, Apps, Connections, Settings,
Sign out) and a sidebar of Topics, Personas, pins and open agent apps. An App's page selected Home and its Topic at
once. The Apps page listed only agent apps, and opened their management, while the sidebar listed other things under
the same word. Connected servers with their own App pinned themselves, so the owner's pins were a mix of choices and
defaults; a signed-out pin vanished. Routines were edited in Settings while Tasks listed them. Persona rows in the
sidebar looked like chats.

## Decision

**One sidebar.** A single moss column (17rem) replaces the rail and the sidebar:

- At its head, goblin's mark (it opens the channel this tab showed last), Jump to (⌘K), and the places Activity, Work
  and Apps.
- In the middle, the part that scrolls: the owner's **Pinned** list, then the **Topics**, always visible on every page,
  each channel with its live threads, then Archived, Add topic and **All threads** (the old Threads place).
- At its foot: Connections, Personas, Settings and an Account menu with Sign out.

There is no Home or Chat place: a Topic is the way to a conversation. Exactly one row shows where the page is, the most
specific that matches: a channel or thread, a pin (an App's page whose view or server is pinned), or a place. A row that
is the page is `aria-current="page"`; a place that only holds the page (Apps, while a non-pinned App's page or an app's
management shows; Personas, on a profile) is `aria-current="true"`. A Topic is never marked while an App's page shows.

**Counts.** Activity counts what needs a response plus unread notifications; Work counts active execution (Delegates at
work, Personas answering), never routines; All threads counts open threads with unread replies. Topic and thread rows
keep their unread dot and working pulse. The phone's navigation button shows a dot, and says the count, while Activity
has something.

**The strip.** On a desktop the owner collapses the sidebar to a strip of icons (its button or ⌘B / Ctrl+B): names in
tooltips and still read out, counts on the icons, the Topics behind one `#` that lists them beside it. The browser
remembers it (`goblin:sidebar:collapsed`) and a script restores it before the first paint; the width switches at once,
never animated over the page. On a phone the drawer holds the same column, expanded.

**Pins are only the owner's.** Nothing pins on its own: `SidebarPins.seen` and `SidebarEdit.adopt` are gone, and a
newly connected server is listed in Apps under Connected. Every stored pin shows in its place with its state: ready,
signed out (it leads to Connections to sign in again), no App any more, closed (opening it opens it again) or not
available; a read not made yet never hides one, and nothing in the browser removes a stored pin. Removing a connection
or deleting an App still takes its pin. The word stays **Pinned**; saving a view means pinning it.

**One Apps launcher.** `/apps` has a search field, Add a connection, and four sections in this order:

- **Pinned**: the pins, in the owner's order, with Move up, Move down and Unpin.
- **Recent**: at most six open, unpinned MCP App views, newest first, one per connection and tool, each with the
  conversation it came from. Nothing about it is stored; older views stay in their conversations.
- **Connected**: every connection that declares its own App, connected or not (Reconnect), one entry per connection.
- **Built for you**: every agent app, with or without a view. Open opens its view (reopening a closed one in the same
  step); Manage opens `/apps/<name>`. Hidden, with its empty state, on a deployment without agent apps; Apps itself
  stays.

Each source loads and fails on its own. Opening, pinning and jumping grant nothing.

**Work.** Tasks is renamed Work (`/work`). It holds Running (Delegates and Personas answering), Routines (moved from
Settings with their controls and confirmations; `/work#routines`), App schedules (every agent app's jobs, with Pause,
Resume and Run now, linking to the app) and Recent results. Settings no longer edits routines.

**Personas and names.** `/personas` lists the Personas, each opening its profile to edit; Persona rows leave the
sidebar. "MCP servers & skills" is called **Topic setup**; Settings' "Apps that use your agent" is **Connected
clients**.

## Consequences

- The vocabulary changes: Home, Threads (as a place), Tasks and the rail are gone; All threads, Work, Jump to, Recent
  and the strip are new. The glossary follows.
- A pin stored by the old default (an adopted server) stays a pin; a server connected from now on is not pinned until
  the owner pins it. Stored documents that still carry `seen` decode unchanged.
- The sidebar is longer on every page, because the Topics stay; the owner folds sections or collapses to the strip.
- ⌘K and ⌘B do not reach the shell while focus is inside a sandboxed App frame.
