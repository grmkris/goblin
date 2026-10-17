# Navigation and Apps redesign plan

Status: implemented on `feat/navigation-and-apps` (2026-10-17) and recorded as ADR 0078. Created 2026-10-16 against
`b3ac028e`, revised the same day with the owner's decisions (section 1.1). Section 10 records where the implementation
differs from this plan.

## 1. Outcome

Make Goblin easy to navigate while keeping conversations, connected services, and apps close together.
A person should be able to predict what a navigation item opens, find an app again, and reach its settings
without learning Goblin's runtime terminology.

The direction is one labelled sidebar whose Topics are always visible, one Apps launcher, a single Pinned concept,
and a clear distinction between opening something and managing it. Keep Goblin's moss identity, the compact service
catalogue, and conversation-aware apps.

Apply these skills during implementation and review:

- [frontend-design](../../.agents/skills/frontend-design/SKILL.md): product-specific hierarchy, real content,
  restrained surfaces, a compact token system, and a critique before implementation.
- [make-interfaces-feel-better](../../.agents/skills/make-interfaces-feel-better/SKILL.md): target sizes, alignment,
  coherent corners, focus and press states, typography, and explicit review coverage.
- [apple-design](../../.agents/skills/apple-design/SKILL.md): predictable destinations, spatial continuity,
  immediate feedback, interruptible drawers, and accessible motion and materials.

The owner's earlier preferences are part of the brief: avoid a border around the whole catalogue, avoid the default
filled shadcn tab strip, show discovery above existing connections, and keep existing connection cards compact.

### 1.1 Owner decisions (2026-10-16)

| Question | Decision |
| --- | --- |
| Topics in the sidebar | Always visible on every page. There is no separate Chat destination; the logo opens the last channel. |
| Favourites and saved views | One concept, **Pinned**, under its existing name and verb. There is no Shortcuts rename and no separate Saved views collection. |
| `SidebarPins.seen`, `SidebarEdit.adopt` | Delete both. Newly connected services are no longer pinned automatically. |
| Running work and schedules | Rename Tasks to **Work** (label and route). |
| Unpinned tool-result views | Add a capped **Recent** section to Apps. |
| Desktop collapse | Collapse to an icon strip that keeps badges, not to nothing. |
| Phase order | Apps launcher and pins first, then the shell. |
| Scope additions | ⌘K quick switcher, ⌘B collapse shortcut, build-an-app empty state, attention dot on the phone menu button. |

## 2. What the current implementation establishes

| Surface | Current meaning | Source |
| --- | --- | --- |
| Rail | Home, Threads, Activity, Tasks, Apps, Connections, Settings, Sign out; counts for threads, activity and tasks | [rail.tsx](../../apps/web/src/components/shell/rail.tsx), [lib/rail.ts](../../apps/web/src/lib/rail.ts) |
| Sidebar | Topics with selected threads (always shown), Personas, Pinned, open built-app views | [sidebar.tsx](../../apps/web/src/components/shell/sidebar.tsx) |
| Apps page | Built-app inventory; cards open management, including apps without a view | [apps-page.tsx](../../apps/web/src/components/apps-page.tsx) |
| App page | An app view with its own conversation, composer, and return path; a closed view shows “Open again” | [apps/page.tsx](../../apps/web/src/components/apps/page.tsx) |
| Server app | Opens a connection's declared interface in its retained thread, then redirects to its app page | [server-app.tsx](../../apps/web/src/components/server-app.tsx) |
| Pins | Stored server/view pins plus implicit server pins (`seen`/`adopt`); signed-out server pins hide; open built apps are listed separately | [pins.ts](../../apps/web/src/lib/pins.ts), [sidebar/store.ts](../../apps/runtime/src/sidebar/store.ts) |
| Tasks | Delegates, Persona invocations, and scheduled routines; routines link to `/settings#routines` | [tasks-page.tsx](../../apps/web/src/components/shell/pages/tasks-page.tsx) |
| Settings | Model, usage, agent settings, notices, routines, clients, account | [settings.tsx](../../apps/web/src/components/settings.tsx) |
| Topic setup | Connections, tools, skills, built apps, and subagents, labelled “MCP servers & skills” | [setup-picker.tsx](../../apps/web/src/components/setup-picker.tsx) |

Facts the plan relies on:

- Pins are one JSON document in `app_sidebar.pins` (a TEXT column), decoded with the `SidebarPins` schema. Deleting a
  connection or an App already removes its pin server-side (`withoutServer`, `withoutView`).
- A built app keeps its App id after its view is closed (`agentAppId` in `apps/runtime/src/apps/registry.ts`), so
  `AgentAppSummary.app` stays non-null for a closed view.
- A connection's entrypoint is persisted (`app_mcp_entrypoints`), so `ServerView.entrypoint` survives sign-out.
  `entrypoints()` currently filters to connected servers only.
- `newThreadWith(draft, from)` already carries a one-shot composer draft into a new thread (`shell/drafts.ts`).
- `@base-ui/react` 1.8.0 provides Dialog, Autocomplete, Combobox, Tooltip and Popover. `packages/ui` has no tooltip
  or command component yet.
- Only the web app links to `/tasks`; no runtime notice or Source message carries that URL.

Two underlying entities must stay distinct in code: a built program, identified by its name, and a kept app view,
identified by its instance ID. An MCP connection can provide a service-wide interface and many tool-result views.
Present these clearly without flattening their identity, permissions, or conversation ownership.

## 3. Navigation

Replace the permanent rail plus sidebar with one sidebar, initially 17rem wide. Today the two consume 21.25rem.
Use full text labels next to icons. The sidebar has three fixed regions and one scrolling region:

```text
+-----------------------------+
| goblin                  [⇤] |  header: logo opens the last channel; collapse (⌘B)
| Jump to…               ⌘K   |
| Activity                  3 |  destinations
| Work                      1 |
| Apps                        |
+-----------------------------+
| Pinned                      |  scrolls
|   mysi                      |
|   Trip tracker            ● |
| Topics                    + |
|   # Personal                |
|       Thread title          |
|   # Travel                ● |
|   Archived (2)              |
|   All threads             2 |
+-----------------------------+
| Connections                 |  footer
| Personas                    |
| Settings                    |
| (avatar) Account          ⋯ |  account menu: sign out
+-----------------------------+
```

Only the middle region scrolls. On short screens the footer stays reachable and never overlaps a row; at 200% zoom the
whole column may scroll as one. Sections keep their device-local fold state (`useFolded`).

| Item | Its job | Notes |
| --- | --- | --- |
| Jump to… | Opens the quick switcher (section 3.5) | Shows the platform shortcut; on a phone it is a row in the drawer |
| Activity | Questions, approvals, grants, notifications, and apps whose schedules need the owner | Badge in section 3.2 |
| Work | Running helpers, Persona responses, routines, and app schedules | Badge in section 3.2 |
| Apps | Pinned, recent, connected, and built apps | No badge |
| Pinned | The owner's stored pins, in their order, on every device | Hidden when there are none |
| Topics | Channels with their live threads, Archived, Add topic, All threads | Always visible |
| Connections | Discover services, connect accounts, and manage access | Footer |
| Personas | Index of specialists called with `@name` | Footer; new `/personas` index |
| Settings | Account, model, usage, memory, notifications, connected clients | Footer |
| Account | Account menu with Sign out | Replaces the rail's Sign out button |

The current sidebar's Personas section and its separate built-app list are removed. Personas move to their index;
built apps are reached from Apps or pinned.

### 3.1 Route and selection rules

Keep existing URLs except `/tasks`, which becomes `/work` with the rename. Goblin is greenfield, so no redirect is kept.

Exactly one row is highlighted: the most specific row that matches the location. A row that *is* the page gets
`aria-current="page"`. A destination that only *contains* the page (Apps while a non-pinned app is open) gets
`aria-current="true"` and the same visual treatment. A Topic is never marked current while an app page is showing.

| Route | Highlighted row | Intended behaviour |
| --- | --- | --- |
| `/` and `/c/$chatId` | The channel's Topic row, or the thread row when `?thread=` is set | Keep signed-in last-channel behaviour, thread panels, and the signed-out landing |
| `/threads` | All threads | Thread index |
| `/apps` | Apps | Unified launcher |
| `/apps/$name` | Apps (`true`) | Built-app management, titled “Manage …” with an Open action |
| `/a/$appId` | Its Pinned row when pinned, otherwise Apps (`true`) | Full-page app; keep its conversation, composer, and the return to its conversation |
| `/connections/$connectionId/app` | Its Pinned row when pinned, otherwise Apps (`true`) | Opens the service interface; keep the redirect to its instance |
| `/activity` | Activity | Attention and notifications |
| `/work` | Work | Running work and automation controls |
| `/personas`, `/p/$id` | Personas | Index, existing profile and `/p/new` |
| `/connections` | Connections | Keep the discovery-first layout and Manage access controls |
| `/settings` | Settings | Configuration after routine controls move to Work |

An inline app stays part of its conversation. Taking it to its page highlights Apps (or its pin); returning it inline
restores its original conversation. Opening a thread from Activity or Work highlights that thread's row. Every page has
a header with its title, so the location is clear while the sidebar is collapsed. Back/Forward and direct links keep
working.

### 3.2 Badges and status marks

| Where | Counts or shows | Source |
| --- | --- | --- |
| Activity | Things needing a response plus unread notifications | `railCounts().activity`, unchanged |
| Work | Active execution: working Delegates and Personas still answering | `railCounts().tasks`, unchanged; never routine totals |
| All threads | Open threads with unread replies | `railCounts().threads`, unchanged |
| Topic and thread rows | Unread dot or working pulse, as today | `ChannelRow`, `ThreadRow` |
| Pinned app rows | A needs-you dot when a built app's schedule needs the owner | From today's `AppRow` |
| Phone menu button | A dot when Activity's count is above zero; the accessible name includes the count | New |
| Collapsed strip | The same counts as the expanded sidebar | New |

The Activity page may still list unread chats, but its badge does not count them. Every mark has text or an accessible
name; colour and animation never carry meaning alone.

### 3.3 Desktop collapse

The header's collapse button and ⌘B (Ctrl+B elsewhere) toggle between the sidebar and an icon strip about 3.5rem wide:

```text
+------+
|  g   |  logo (last channel)
|  ⌕   |  Jump to
|  🔔3 |  Activity
|  ▶1  |  Work
|  ▦   |  Apps
|  ──  |
|  ◼   |  pinned tiles (AppTile or service artwork)
|  ◼●  |
|  #●  |  Topics: a popover of active Topics and All threads
|  ──  |
|  🔌  |  Connections
|  @   |  Personas
|  ⚙   |  Settings
|  ◯   |  Account menu
|  [⇥] |  expand
+------+
```

- Every icon-only item has an accessible name and a tooltip on hover and focus. Add a shared Tooltip to `packages/ui`
  from Base UI if none exists by then.
- The Topics item opens a popover listing active Topics (with unread dots) and All threads. Escape closes it and
  returns focus to the trigger.
- Store the state in a cookie the server reads, so the first paint matches and does not flash. Without the cookie,
  show the sidebar expanded.
- Toggling switches the layout immediately. Do not animate width: it reflows the conversation and resident app
  iframes on every frame. Labels may fade in over at most 120ms.
- ⌘B does nothing on a phone. Shortcuts pressed inside a sandboxed App frame do not reach the shell; this is accepted.

### 3.4 Phone layout

```text
+----------------------------------+
| Menu●  Apps                      |
| Search apps                      |
|                                  |
| Pinned                           |
| mysi                        Open |
|                                  |
| Recent                           |
| Hotel results      From #Travel  |
|                                  |
| Connected                        |
| Calendar                    Open |
|                                  |
| Built for you                    |
| Trip tracker                Open |
+----------------------------------+
```

The left drawer contains the same single navigation column, expanded. A tap on any link closes it, including a link to
the current location. A swipe closes it towards the edge it came from. Escape and browser Back close it. Return focus
to the menu button on dismissal; after navigation, move focus to the destination heading. Keep the current safe-area
and keyboard protections. A bottom tab bar is out of scope (section 9).

### 3.5 Quick switcher (⌘K)

⌘K (Ctrl+K elsewhere) and the Jump to row open a dialog with one search field and a result list:

- **Built from:** the shared Dialog and Base UI Autocomplete. If the component is reusable, add it to `packages/ui`.
- **Items:** destinations, active Topics, open threads by title, Pinned items, Recent views, connected apps, built
  apps, Personas, and the anchored Settings and Work sections (for example `/work#routines`).
- **Data:** only what the workspace feed and already-cached queries hold. There is no new server search and no search
  of transcript content.
- **Ranking:** exact prefix, then word start, then substring; ties are broken by current-section relevance, then
  recency where it is known. Show at most about 8 rows per group.
- **Rows:** each row names its kind (“Topic”, “Thread in #Travel”, “App”, “Persona”) in text, not just by icon.
- **Behaviour:** Enter navigates and closes. Escape closes and restores focus. Opening never changes pins, grants or
  app powers.
- **Focus:** the composer has no ⌘K handler today. Verify that the dialog takes focus from the composer and gives it
  back.

## 4. Apps: one inventory, predictable actions

The Apps page has a search field (by name and connection label), an “Add a connection” action, and four sections
with sentence-case headings, in this order. There is no pill-tab container and no enclosing border.

| Section | Inventory and stable identity | Primary action | Secondary actions |
| --- | --- | --- | --- |
| Pinned | Stored pins in the owner's order, keyed by `pinKey` | Open | Move up/down, Unpin; Reconnect when signed out |
| Recent | Up to 6 open, unpinned MCP tool-result views, newest first, one per connection + tool, keyed by App id | Open that exact view | Pin, Go to conversation |
| Connected | Connections with a declared entrypoint, connected or not, keyed by connection ID | Open when connected; Reconnect when signed out | Manage access, Pin/Unpin |
| Built for you | Every built-app summary, keyed by program name | Open when it has a view; Manage when it has none | Manage, Pin/Unpin when it has a view |

Section rules:

- **Recent** is derived from the AppView slice: `source.kind === 'mcp'`, `entrypoint !== true`, `closedAt === undefined`,
  not pinned. Each row shows its name (`appNames`) and its conversation (“From #Travel”). It stores nothing. Older
  views stay in their conversation. Hide the section when it is empty.
- **Connected** changes the `entrypoints()` filter for this use, so signed-out connections stay listed with
  Reconnect. Two connections to one service are separate entries named by their labels. Services that expose tools
  but no interface belong only to Connections and never produce an empty app tile.
- **Built for you** is hidden, with its empty state, when `features.agentApps` is false. Apps itself stays: it still
  serves Pinned, Recent and Connected.
- Pinned items also appear in their own section. Search filters every section.

Build the launcher from the existing `serversQuery`, `agentAppsQuery`, the workspace AppView slice, and stored pins.
Keep each source's loading and error state independent. A failed built-app read must not hide connected apps or show
“No apps yet”.

Opening and managing:

- **Opening is one navigation action.** Open on a built app or pin whose view is closed reopens it (`closed: false`)
  and navigates, in one step. The app page's own “Open again” stays for direct links and Back.
- **No nested controls.** Keep menus outside the primary link. Management always has its own named action.
- **Card contents.** Keep version and state revisions off launcher cards; they belong on the management page.
  Launcher cards show the title, a one- or two-line description, the origin, and needs-you text (powers to allow, a
  schedule needing the owner, failing) as today's `needs()`.
- **Residency.** Reuse the current AppHost: moving between a conversation and an app page keeps the same iframe and the
  unsent draft.
- **Separate actions.** Closing a view, deleting a program, revoking access and unpinning stay separate. A closed view
  can be reopened, and unpinning does not close a view. Opening or pinning never grants tools or app powers.

Empty states:

- With no apps at all, point to “Add a connection” and offer the build action below.
- When there are no built apps (and `agentApps` is on), show **“Ask goblin to build an app”**. It calls
  `newThreadWith({ text: 'Make me an app that ', selections: [], attachments: … }, lastChannel())`. That opens a new
  thread in the last channel with the request pre-filled and the caret at the end. Nothing is sent until the owner
  sends it.
- Loading reserves each section's eventual shape.

### 4.1 Pins

- **One concept.** Pinned keeps its name, its pin and unpin verbs, and its glossary entry. Saving a view means pinning
  it.
- **No automatic pins.** Delete `SidebarPins.seen`, `MAX_SEEN`, `SidebarEdit.adopt` and every use of them:
  - `packages/contracts/src/sidebar.ts`
  - `apps/runtime/src/sidebar/store.ts` (including `withoutServer`'s `seen` bookkeeping)
  - `apps/web/src/lib/pins.ts` (`adopt`, `afterAdopt`)
  - `apps/web/src/sidebar/hooks.ts`

  A newly connected service appears in Apps → Connected, where the owner can pin it.
- **Storage.** Pins are JSON in one TEXT column, so no column or migration changes. Confirm that decoding a stored
  document that still has `seen` ignores the extra key (Effect Schema's default for excess properties). If it does
  not, reset dev (test data only) rather than add a legacy decoder.
- **Existing pins.** Stored pins keep their targets and order, including pins adopted earlier. Keep the existing
  revision and stale-retry handling.
- **Unavailable pins.** Deleted targets are already removed server-side, which leaves three states, each rendered
  explicitly in its place:
  - Signed-out server: shown dimmed, with Reconnect and Unpin. Today it is hidden.
  - Server that no longer declares an app: “No app any more” and Unpin.
  - Closed view: Open reopens it.

  Never treat a loading or failed read as removal, and never delete stored targets on the client.
- **Identity.** Deduplicate by `pinKey`, never by visible title. Two connections to one service are different
  accounts; two pinned views may share a title.
- **Ordering.** Keep Move up/down as accessible menu actions in the sidebar and on the Apps Pinned section. Drag
  reordering is deferred.

## 5. Work, Personas, and configuration

**Work** (renamed from Tasks; route `/work`) answers “what is running?” and “what have I scheduled?” in one place. It
has named sections: Running, Routines, App schedules, and Recent results.
- Persona invocations and Delegates stay distinguishable as different kinds of work.
- A routine, an app's scheduled job and a Persona response keep their existing underlying models.

Routine controls:
- Move the routine review and edit controls from Settings into Work, reusing those controls with their exact
  confirmation semantics.
- Point every old Settings routine link at `/work#routines`, and remove Settings' routine editor so there is only one.

App schedules:
- Expose an app's schedule controls through the existing `changeAgentApp` API (pause/resume, run now), with a link to
  the app's management page.
- Derive app schedules from the complete program inventory (`agentAppsQuery`), so a background-only program or a
  closed view never disappears from Work.
- Respect the `agentApps` flag and each query's read errors.

Activity and Work:
- Activity is where the owner responds: approvals, questions, notifications, and apps whose schedule needs them.
- Work shows progress and automation state. When a schedule needs the owner, Work's row says so and links to the
  same action rather than duplicating it.

Personas get a compact index at `/personas`: name, role, an explicit Edit action, and Add persona.
- Explain once that `@name` calls a Persona into a conversation.
- Keep `@` invocation and profile revision history.
- Do not imply that a profile is a direct chat.

Renamed labels:
- Rename “MCP servers & skills” to **Topic setup** where people open it, and explain that it chooses the tools,
  skills, apps and helpers available in that Topic.
- Keep the matching Persona setup described as what that Persona adds. Connections continues to own global grants.
- Rename Settings' “Apps that use your agent” to **Connected clients**, with a short note that these are external
  clients using Goblin.

### 5.1 Vocabulary changes

Record every change in one table in the ADR, and update [GLOSSARY.md](../../GLOSSARY.md):

| Before | After | Glossary change |
| --- | --- | --- |
| Rail, Home | Sidebar; the logo opens the last channel | Remove **Home**; reword entries that say “the rail's page” |
| Tasks | Work | Rename the entry; route `/work` |
| Threads (rail) | All threads (end of Topics) | Unchanged meaning |
| Pin: “a connected server with its own App is pinned until the owner unpins it” | Pins are only what the owner pinned | Edit **Pin** |
| Apps page: built apps only | Apps: Pinned, Recent, Connected, Built for you | New **Apps** entry; **Server App** “opened from Apps, its pin or its card” |
| — | Recent; Jump to | New entries |
| MCP servers & skills | Topic setup | New or updated entry |
| Apps that use your agent | Connected clients | New entry |

## 6. Visual direction and tokens

Use Goblin's existing moss sidebar as the defining visual choice. Pair it with quiet, left-aligned content, clear type,
and compact app rows and cards. The recent Connections redesign is the density reference. The shared styling system is
Tailwind 4 with local shadcn/Base UI primitives, shared semantic CSS variables, and app CSS in `shell.css` and
`styles.css`. Work within that system.

These six hex values are rounded sRGB references for existing light-theme tokens, not replacements for the OKLCH
source. Keep the semantic variables and their existing dark-theme counterparts, and verify final contrast in both themes.

| Reference | Hex | Existing token / purpose |
| --- | --- | --- |
| Canvas | `#FAFAF9` | `--background`; workspace surface |
| Ink | `#0D1014` | `--foreground`; readable primary text |
| Moss sidebar | `#233E27` | `--shell`; navigation identity |
| Moss action | `#34653C` | `--moss`; meaningful primary action |
| Lichen selection | `#E4EDC8` | `--shell-active`; current row |
| Attention | `#D5613D` | `--shell-badge`; existing attention count |

Keep Geist Variable and the shared system fallback. Hierarchy comes from weight and size together:

| Element | Size / weight |
| --- | --- |
| Navigation rows | `--text-15` / 400 |
| Unread rows | `--text-15` / 650, as today; the gap from 400 must stay obvious |
| Section headings | `--text-13` / 600, as today |
| App titles | 16px / 600 |
| Descriptions | 14px / 400 |
| Page titles | 24px / 600, tracking slightly tightened |

Express sizes in rem. Keep body tracking neutral with comfortable leading. Use tabular numerals for counts and changing
times.

Targets:
- Full-width text rows start at 2.125rem (34px) on desktop, up from 1.875rem. The prototype settles the final value
  between 2rem and 2.25rem.
- Icon-only controls (fold arrow, ⋯, section +, collapse) get a hit area of at least 40×40px on desktop, extended with
  a pseudo-element that does not overlap the row's link.
- Every control on a coarse pointer gets 44px, as today. Keep a visible focus ring.

Surfaces:
- Keep broad lists quiet. Use cards only where a bounded app has a description and independent actions, with no
  enclosing catalogue border and no stack of nested cards.
- Start around a 12px card radius and 8px padding around an inset 4px-radius control, and check concentric corners
  where elements are actually nested.
- Separate elevation from structure: a restrained shadow for a floating menu, popover or sheet; spacing for
  collections; borders only for focus, selection, or high-contrast needs.

Icons and artwork:
- Keep Lucide for interface controls, using `currentColor` and a consistent optical weight.
- Keep existing service artwork where it exists and the deterministic AppTile fallback otherwise. Do not make up brand
  marks.

Text, states and empty pages:
- Let long descriptions wrap. Truncate long titles only when the full accessible name remains available, and show the
  full title in the tooltip on the collapsed strip.
- Selected, unread, working, needs-you and error states stay visually distinct and have text or accessible names.

### Behaviour and motion

Navigation responds immediately. Use 120–150ms colour/opacity transitions for hover and focus changes. Avoid
route-entry staggering, app-grid rearrangement animations, scaling whole rows, and animating the sidebar's width. Small
action controls may use the existing `scale(0.96)` press treatment; static controls keep instant colour feedback.

Reuse the shared Base UI Drawer for navigation and management sheets. It already tracks drag movement without a
transition and uses gesture-aware dismissal. Verify reversal, slow drag cancellation, fast flicks, and focus before
changing its motion. If a new spring is required, start with no bounce and a 0.3–0.4s response, using the existing
spring utility rather than another animation package. Do not delay routing until a decorative animation ends.

Keep sidebar chrome solid for legibility. Reserve restrained translucency for a floating header or sheet over
scrolling content, with solid fallbacks for reduced transparency and increased contrast. Under reduced motion, use
immediate state changes or brief fades. Inspect animated interactions at 10% speed and at normal speed during browser
review.

### Critique of the proposal

The obvious first direction would keep the Slack rail and add an Apps tab strip. That keeps two navigation systems and
repeats the owner's disliked treatment. A second draft showed Topics only inside a Chat destination. That made the
column's contents change per page and put topic switching two clicks away from Apps, Activity and Work.

The adopted design:
- removes the rail and keeps one stable column whose Topics are always present;
- gives Apps one inventory and uses plain section headings;
- folds favourites and saved views into the single Pinned concept that already exists.

Goblin's identity comes from its moss navigation, Topics, and apps with a live conversation, not from a new decorative
theme. Check the prototype with populated inventories before settling density, because a large generic tile grid could
recreate the space problem the Connections iteration just fixed.

## 7. Implementation sequence

Branch from `dev`, not from `spike/openui`. Each phase ends with a coherent, independently reviewable commit (or a few),
committed with exact paths only. Recheck ownership and the current integration before each phase. The paths below
identify affected areas, not ownership of another agent's live edits.

0. **Decision record.** Write the ADR. It supersedes the rail of ADR 0036, the automatic server pins of ADR 0053, and
   ADR 0021's separate sidebar list of agent apps. Check whether ADR 0064's hidden Apps page changes, and record it
   if so. Include the vocabulary table (5.1), the selection rule (3.1), the badge table (3.2) and the pin semantics
   (4.1). Claim the ADR number when merging: it is 0078 at the time of writing, but parallel work has collided on
   numbers before. Update `docs/adr/README.md`.
   **Exit:** the owner accepts the ADR.
1. **Apps launcher and pins.** Ship this inside the current shell:
   - the four-section launcher, with search and independent query states;
   - Open reopening closed views, and Reconnect for signed-out connections;
   - the Recent derivation and the build-an-app empty state;
   - removal of `seen`/`adopt` across contracts, runtime and web, and the unavailable-pin states;
   - removal of the sidebar's separate built-app list, keeping the rail's Apps link when `agentApps` is false.

   **Exit:** the Apps rows of the behaviour matrix pass. Stored pins keep identity and order. Switching surfaces keeps
   the iframe and draft. The owner reviews screenshots of a populated launcher.
2. **Shell prototype, then swap.**
   - Build the single sidebar with populated fixtures in the existing UI harness (`docs/agents/ui-follow.ts`,
     `scripts/ui-acceptance.ts`), at desktop and phone sizes, expanded and collapsed.
   - Run the five-task check below with the owner.
   - Then replace the rail and sidebar: always-visible Topics, Pinned, footer and account menu, the collapse strip
     with its cookie and ⌘B, the phone attention dot, the `/personas` index, the selection rule, and the badges.

   **Exit:** every route has a reachable highlighted row and a predictable way back, and the five-task check meets its
   click budgets.
3. **Work and configuration.**
   - Rename Tasks to Work, including the route `/work`.
   - Move routine controls and show app schedules.
   - Update every `/settings#routines` link.
   - Rename Topic setup and Connected clients.

   **Exit:** routine and app-job controls go through existing authority checks, and Settings no longer has a second
   routine editor.
4. **Quick switcher.** ⌘K dialog and the Jump to row, as specified in section 3.5.
   **Exit:** every sidebar destination, Topic, open thread, Pinned/Recent/connected/built app and Persona can be
   reached from the keyboard alone, and focus returns correctly.
5. **Fit, verification and release.**
   - Complete keyboard, touch, theme, motion, long-name, loading and error states.
   - Update README, architecture docs, GLOSSARY.md, `docs/agents/ui.md` and the relevant skills to match what was
     built.
   - Run final checks against current `dev`, then publish through the normal dev CI flow.

### Five-task check (phase 2 gate)

Run against the prototype with populated data (several Topics, 3+ pins, two accounts on one service, a closed view, a
background-only built app, a paused routine, a waiting approval). Record clicks and time for each task, and get the
owner's sign-off on the screenshots.

| Task | Expected path | Click budget |
| --- | --- | --- |
| Reopen yesterday's hotel results | Apps → Recent row (or ⌘K) | 2 |
| Pause a routine | Work → Routines → Pause | 3 |
| Answer a waiting approval | Activity → item → answer | 3 |
| Find Trip tracker's schedule settings | Apps → Built for you → Manage | 3 |
| From Apps, switch to #Travel | Sidebar → #Travel | 1 |

### Expected code touchpoints

| Area | Files / directories |
| --- | --- |
| Shell and selection | `apps/web/src/components/shell/` (`shell.tsx`, `rail.tsx` removed, `sidebar.tsx`, `sidebar-state.ts`, `navigation.tsx`), `apps/web/src/lib/{rail,topics,last-channel}.ts`, `apps/web/src/shell.css`, the root route for the collapse cookie |
| Launcher and queries | `apps/web/src/components/apps-page.tsx`, `apps/web/src/routes/apps.index.tsx`, `apps/web/src/agent-apps/queries.ts`, `apps/web/src/mcp/queries.ts`, `apps/web/src/lib/{entrypoints,app-names}.ts` |
| Pins contract and store | `packages/contracts/src/{sidebar,workspace}.ts`, `packages/contracts/src/api/sidebar.ts`, `apps/runtime/src/sidebar/{store,service}.ts` and their tests |
| Pins in the web app | `apps/web/src/lib/pins.ts`, `apps/web/src/sidebar/hooks.ts` |
| App lifecycle | `apps/web/src/components/apps/{page,host}.tsx`, `apps/web/src/components/server-app.tsx` |
| Empty-state action | `apps/web/src/lib/navigation.ts`, `apps/web/src/components/shell/{navigation.tsx,drafts.ts}` |
| Work and routines | `apps/web/src/routes/tasks.tsx` → `work.tsx`, `apps/web/src/components/shell/pages/tasks-page.tsx`, `apps/web/src/components/{routines,routine-review,app-manage,settings}.tsx` |
| Personas and Topic setup | `apps/web/src/components/shell/pages/persona-page.tsx`, new `/personas` route and component, `apps/web/src/components/shell/channel-menu.tsx`, `apps/web/src/components/{topic-setup,setup-picker}.tsx` |
| Quick switcher | New `apps/web/src/components/shell/jump-to.tsx`, a reusable Autocomplete/command wrapper in `packages/ui` if it earns reuse |
| Shared UI | `packages/ui/src/styles.css`, a Tooltip in `packages/ui` |
| Docs | New ADR, `docs/adr/README.md`, `GLOSSARY.md`, `docs/architecture/{agent-apps,mcp-apps,topics,routines}.md`, `README.md`, `docs/agents/ui.md` |
| Verification | `apps/web/test/`, `apps/runtime` sidebar store tests, `docs/agents/ui-follow.ts`, `scripts/ui-acceptance.ts` |

Keep API calls in the typed Query layer and reuse the workspace feed. Add no navigation-specific server store, no new
app identity scheme, and no migration merely to regroup the interface. The only contract change is deleting
`seen`/`adopt`. If implementation exposes another contract gap, document it and follow the owning runtime/contracts
instructions before changing it.

## 8. Acceptance and verification

### Behaviour matrix

- [ ] A connected service with an interface appears in Apps → Connected without being pinned. A signed-out one shows
      Reconnect. A tools-only connection appears only in Connections. Separate accounts are separate entries.
- [ ] Connecting a new service pins nothing. Contracts, runtime and web have no `seen` or `adopt` left, and stored pin
      documents still decode.
- [ ] A built app with a view opens directly, reopening a closed view in the same step; Manage is separate. A
      background-only app has Manage and stays visible in Work when scheduled.
- [ ] Recent shows at most 6 open, unpinned tool-result views, one per connection + tool, each with its conversation.
      Pinning one moves it to Pinned. Nothing about Recent is stored.
- [ ] A pinned tool-result view reopens the exact instance with its original conversation. Changing placement creates
      no duplicate iframe, and unsent input survives.
- [ ] Exactly one row is highlighted per route (3.1). An app page never marks its Topic. Direct loads, reloads,
      redirects, Back/Forward, `/work` and unavailable IDs all have useful outcomes.
- [ ] Pins keep their stored order across devices. Stale retry, unpin, move, reconnect, “no app any more” and closed
      views behave explicitly. Loading or read errors never hide or erase a pin.
- [ ] With built apps disabled, Apps still shows Pinned, Recent and Connected; Built for you and its empty state are
      hidden. Each query's error and retry stay local.
- [ ] Badges follow 3.2. Work never counts routines as running, and the phone menu button and collapsed strip show the
      same counts.
- [ ] Work includes routines and app schedules, including jobs without an open app view. Existing confirmation,
      pause/resume, run and failure handling stay intact. Old routine links reach `/work#routines`.
- [ ] Personas can be found and edited from `/personas`; invocation still happens through `@name`.
- [ ] “Ask goblin to build an app” opens a new thread in the last channel with the request pre-filled and unsent.
- [ ] ⌘K reaches every item listed in 3.5, ranks prefix matches first, and returns focus. ⌘B toggles collapse on
      desktop and the state survives a reload without a flash.
- [ ] Topic selection, Persona additions, global revocations and exact tool/app grants keep their current semantics.
      Opening, pinning or jumping never expands authority.

### Visual and interaction matrix

- [ ] Check 1440×900 desktop (expanded and collapsed), a constrained tablet, a 390×844 touch phone, and phone
      landscape, in light and dark themes.
- [ ] Check empty, typical and long inventories and Topic lists; long names; background-only apps; disconnected
      services; multiple accounts; waiting approvals; network failure; and disabled actions. No horizontal page
      overflow, and the footer stays reachable on a 700px-high window.
- [ ] Check keyboard-only navigation, focus visibility and restoration, screen-reader names (including the collapsed
      strip and the menu-button count), route announcements, 200% zoom, and touch target geometry. Menus work
      independently of app links.
- [ ] Check drawer opening, cancellation, reversal, same-route tap dismissal, swipe dismissal, Escape and browser Back.
      Confirm the existing app safe areas, keyboard inset and thread return controls still work.
- [ ] Check hover, focus, active, loading, empty and error states, and inspect motion at 10% and normal speed. Repeat
      with reduced motion, reduced transparency and increased contrast.
- [ ] Review real screenshots before accepting density and alignment. Keep private account screenshots and session data
      out of the public repository; publish only redacted or synthetic evidence.

### Checks for implementation

Extend the existing behaviour suites where the change needs proof: `rail.test.ts`, `home.test.ts`, `topics.test.ts`,
`pins.test.ts`, `app-names.test.ts`, `entrypoints.test.ts`, `apps-page.test.tsx`, `shell-extras.test.ts`, the runtime
sidebar store tests, and the relevant app residency, chat and query tests. Add behavioural coverage for:
- the most-specific-row selection rule;
- launcher composition (sections, deduplication by identity, the Recent cap and filters, feature flags, partial
  failures);
- pins without `seen`/`adopt`;
- switcher ranking;
- the collapse cookie's first paint.

Do not add snapshots of arbitrary markup or tests that merely repeat styling constants.

Run expensive commands through `heavy`, without a pipe:

```sh
heavy bun run check:fast
heavy bun run check
heavy bun run ui:acceptance
```

`ui:acceptance` needs an authorised local or dev session and an updated page matrix covering `/personas`, `/work`, app
pages and the collapsed shell. It only reads, so verify state-changing operations separately, in the existing
controlled fixtures or a dedicated dev test account. Treat exit 75 as contention and retry unchanged. Record pass/fail/
skip counts, and keep local, authenticated-browser and deployed evidence separate.

For the dev release: integrate current `origin/dev`, rerun affected checks, push through the normal CI, verify the
deployed commit, and check the changed routes on dev. Production remains frozen and out of scope.

## 9. Design review record

Mode: full, bounded to the navigation and Apps proposal. Framework: React and TanStack Start/Query; styling: shared
Tailwind/Base UI primitives and semantic CSS. Evidence is source inspection at `b3ac028e` and a second review pass that
produced the owner decisions in 1.1. No authenticated visual walkthrough has been done for this plan. Proposed values
and interactions are acceptance targets, not measured results.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | `packages/ui/src/styles.css`, `apps/web/src/shell.css`, navigation/app components | Geist and tabular counts kept; unread weight (650) must stay distinct from row weight (400) |
| Surfaces | Shell composition, sidebar controls, launcher and management components, shell CSS | Hierarchy, target-size and pin-model findings below |
| Animations | Shell hover/press rules, shared Drawer, motion utility | Gesture foundation kept; no width animation on collapse; interruption and 10%-speed review not verified |
| Icons | Rail, sidebar, `AppTile`, semantic colour usage | Labels and tooltips needed on the collapsed strip; rendered alignment not verified |
| Performance | Query ownership, workspace slices, app host, motion dependencies | No extra streams, eager app mounting, server search or animation dependencies; runtime not measured |

### Grouping, naming and wayfinding

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `shell/shell.tsx:25`, `sidebar.tsx:338`, `rail.tsx:53` | Two navigation columns | One sidebar: destinations, Pinned, always-visible Topics, footer utilities and account menu | One stable column explains where everything belongs |
| MEDIUM | `apps-page.tsx:18`, `lib/app-names.ts:57`, `app-manage.tsx:53` | Apps page and sidebar hold different inventories with different default actions | One launcher (Pinned, Recent, Connected, Built for you), direct Open, explicit Manage, independent reads | The same label and action should mean the same thing |
| MEDIUM | `rail.tsx:25`, `sidebar-state.ts:54` | Full-page apps select Home and can also select their Topic | Most-specific-row rule; apps highlight their pin or Apps | Wayfinding should reflect the page in use |
| MEDIUM | `lib/pins.ts:31`, `contracts/src/sidebar.ts:40`, `sidebar.tsx:359` | Implicit pins mix with stored choices; a second built-app list; signed-out pins vanish | Only stored pins; `seen`/`adopt` deleted; explicit unavailable states; complete inventory in Apps | Agency and stable identity make pins understandable |
| MEDIUM | `lib/rail.ts:100` | The proposal dropped the Threads stop and with it the unread-thread count | Count on All threads; Activity's badge unchanged | Merging unread replies into Activity would keep its badge permanently non-zero |
| MEDIUM | `apps/page.tsx:59`, `registry.ts:206` | Opening a closed built-app view lands on “Open again” | Launcher Open reopens and navigates in one step | Opening should open |
| MEDIUM | `tasks-page.tsx:87`, `settings.tsx:26`, `app-manage.tsx:251` | Work and schedule controls spread across pages | Work owns the overview, routines and app schedules, with links to owners | Group controls with what they affect |
| MEDIUM | `sidebar.tsx:280`, `topic-setup.tsx:122`, `settings.tsx:29` | Persona rows look like chats; setup/client labels hide their scope | Personas index with Edit, Topic setup, Connected clients | Specific names make contents predictable |
| MEDIUM | `shell.tsx:16` | The phone menu button gives no sign of waiting approvals | Attention dot and count in its accessible name | Attention should not hide behind a closed drawer |

### Hit areas and restraint

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `shell.css:184`, `:192`, `:233` | Rows and icon controls 30px on desktop; 44px on coarse pointers | Rows 34px (settled in the prototype), icon-only controls at least 40×40px, 44px on touch, no overlap | Precise targets without the taller tree a blanket 40px row would cause |
| LOW | `apps-page.tsx:23`, `apps/app-tile.tsx:5` | Management-first cards with version lines; generic tiles | Compact launcher rows/cards with origin or conversation context, service artwork, needs-you text | Useful content, not decoration, creates hierarchy |

The token, typography and motion specifications preserve and guide existing choices; they do not claim that every
current colour, transition or icon is a defect.

### Considered but rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Shell | Keep the rail and add an Apps navigation strip | Duplicate navigation, and repeats the owner's rejected tab treatment |
| Shell | A Chat destination whose Topics show only while it is selected | The column changes per page and topic switching costs two clicks elsewhere (owner, 2026-10-16) |
| Pins | Rename Pinned to Shortcuts, plus a separate Saved views collection | Two names for one stored bit; Shortcuts suggests automations (owner, 2026-10-16) |
| Pins | Keep `seen` for a “New” marker | Dead weight once automatic pins go; Connected already makes new services discoverable (owner, 2026-10-16) |
| Collapse | Hide the sidebar completely | Loses the attention counts (owner, 2026-10-16) |
| Collapse | Animate the sidebar's width | Reflows the conversation and resident iframes on every frame for no gain in understanding |
| Phone | Bottom tab bar | Competes with the composer and keyboard inset; the drawer plus the attention dot covers the need |
| Apps | Default filled tabs, a bordered bento wrapper, large identical tiles | Repeats the owner's rejected treatment and spends space without clarifying anything |
| Global chrome | Glass and spring motion on every surface and page transition | Hurts readability over varied app content and adds repeated distraction |
| App model | Merge program names, connection IDs and view IDs into one entity | Different lifecycles and authority boundaries still matter; only discovery is unified |

Verification so far:
- Done: source inspection with `rg` and file reads at `b3ac028e`, and an earlier public dev health read.
- Not done: application implementation, runtime tests, visual snapshots, motion replay, or a new deployment.

Verdict: **Needs changes** for the current navigation. The proposed design is **not verified** in authenticated
desktop or mobile browsers, with keyboard or screen reader, in light and dark themes, under motion preferences, for
runtime performance, for state-changing flows, or after deploy. Those checks belong to phases 1–5.

## 10. Implementation record (2026-10-17)

Built in parallel lanes (Apps launcher, Work and configuration, Jump to) and the shell, merged on
`feat/navigation-and-apps`. Where it differs from the plan above:

- **Strip memory.** The collapsed state is kept in the browser's storage and restored by a script before the first
  paint (`data-sidebar` on the root, as the theme script does), not in a cookie the server reads. The first paint still
  matches and nothing flashes; the server never needs to know.
- **Targets inside rows.** A pin's ⋯ menu sits inside its 34px row, so it is as tall as the row (36×34px) rather than
  40px, which would cover the rows beside it. Standalone icon controls (collapse) are 40px; every control is 44px on a
  coarse pointer. Apps' ⋯ buttons, outside rows, are 40px.
- **Links' own active state.** The router marks an active link `aria-current="page"` by prefix, which marked a channel
  while its thread showed (a bug the old sidebar had too). Sidebar links are now active only on their exact place, so
  the one-row rule alone decides.
- **Recent** orders by creation time; the app keeps no last-opened time.
- **Jump to** breaks ties by group, then each source's own order (threads already unread first, then newest); it reads
  the connected apps from the launcher's list.
- **Topic setup** is the Topic's; a Persona's setup is titled "What it adds".
- **The agent** now tells the owner to confirm a proposed routine in Work → Routines.

Evidence (local): `heavy bun run check` green on the integrated branch; browser fixtures `ui-navigation.ts`,
`ui-apps.ts`, `ui-jump.ts` and `ui-setup.ts` pass at desktop and phone widths in light and dark. Not verified: an
authenticated walk on dev, a screen reader, real devices.

