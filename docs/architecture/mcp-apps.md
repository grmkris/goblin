# MCP Apps host

## MCP Apps host

An App is a tool's `ui://` resource, served by the server that answered the call. It runs in two nested opaque
sandboxed frames (`lib/app-sandbox.ts`). The outer proxy only relays protocol messages to and from the host's origin.
Its calls go through the owner API to the originating server and need that server's grant.

The app is a Slack-style shell (ADRs 0036 and 0078, `components/shell`): the sidebar, then the channel, with the
thread panel placed by the channel's own width (a container query): beside it where the channel can spare the panel,
over its right side where it cannot, over all of it (with a crumb back) where the rest would be too narrow to read, and
as a full view of its own on a phone. The
channel and the panel are fixed to the viewport beside the navigation, so the composer's keyboard handling holds; each
draws its own bar (the channel's `#name`, the panel's back crumb, title, menu and ×) as translucent chrome over its
transcript. Apps and composers reach the shell only through `lib/navigation.ts`, which `components/shell/navigation.tsx`
implements over the router.

Apps are kept (ADR 0020). A call the owner's agent makes to a tool that declares an App keeps it in the agent's
registry (`apps/registry.ts`, `app_registry`, one per Pi session and call); `chat_id` names its placement while the
original Pi session and call id still own the arguments and results. *Show app* on an older or closed one keeps it
through `POST /api/apps`. The workspace feed lists them (an App's name is numbered when one title repeats in its
conversation, `lib/app-names.ts`), and closing a conversation closes its Apps. `GET /api/apps/:id/launch` reads the call's arguments and redacted result back from the
transcript; keeping and launching grant nothing.

Several Apps run at once, in any conversation the owner views (`components/apps`). `AppHost` holds one instance per
loaded App, and `AppLayer` draws one fixed stage per instance outside the chats, never moved in the DOM, so nothing
reparents an opaque frame or replaces its bridge. A stage follows its App's page, then its place
under its tool row (`app-page:<id>`, `app-inline:<id>` slots), frame by frame, including while chats scroll, and
springs between these places (`lib/spring.ts`). It clips itself to the containers that scroll its slot, to its chat's
bar and composer (`data-app-cover` inside the chat's `data-app-scope`) and to the thread panel lying over a channel
(`data-app-overlay`, `lib/app-occlusion.ts`), which also keeps pointer events off what is hidden; text fades out under the same chrome through a mask on the transcript. An App
loads when its place comes on screen; beyond six instances the least recently seen unloads to a stub
(`lib/app-residency.ts`), while one on screen never does. The advertised modes are inline and fullscreen (ADR 0053, no
picture-in-picture): fullscreen is the App's page, `/a/<id>`, the main column under a bar with "Back to #channel", the
App's name, its menu (Pin to sidebar, Back in the conversation) and Close. On the page goblin's composer for the App's
conversation (`ConversationDock`) floats over the room's bottom edge with the agent's presence on it; it and the line
above it are one bar marked `data-app-cover` in the page's `data-app-scope`. The stage is drawn over the page, so only
its clip lets the bar show and take taps: each time the bar moves or resizes (a reply line, a question or a chip), the
page kicks the stages to clip again, and the App is told what it covers as `safeAreaInsets.bottom` (with the sides'
safe areas, read through a probe outside the page), its `containerDimensions` the whole room (`host.insets`,
`components/apps/page.tsx`). A reply finished while the page is open shows as one line over the
composer (`lib/app-chat.ts`); a tap opens the conversation beside the App, or in a sheet over its lower part on a phone
(`data-app-overlay`), as the thread panel shows it. In its transcript the host's bar above an App pins it, opens its
page or closes it. Agent apps are listed in the sidebar's Apps section and on the Apps page (`/apps`, `/apps/<name>`:
`components/apps-page.tsx`, `components/app-manage.tsx`). Grant cards, link offers and context sharing remain
host-drawn, per App.

The Pinned list (ADRs 0053 and 0078, `components/shell/sidebar-pins.tsx` and the top of Apps, over the pure
`lib/pins.ts`) shows the owner's pins, whole servers (they open the server's own App) and single App views, in their
order. They are one revisioned row in the agent (`app_sidebar`, `sidebar/`), read and edited through `GET` and
`POST /api/sidebar` and carried on the workspace feed (`sidebar`), so every device follows. Only the owner pins: a
newly connected server is listed in Apps under Connected. Every pin shows in its place with its state (ready, signed
out, no App any more, closed, not available); a read not made yet never hides one. An edit made from an older revision
answers `stale`, and the browser makes it once more from the pins it brings. Removing a connection (`mcp.removed`) or
deleting an App (`apps.removed`) takes its pin.

Apps (`/apps`, ADR 0078, `components/apps-page.tsx` over the pure `lib/launcher.ts`) is the one launcher: the pins,
the recent App views (at most six open, unpinned MCP App views, one per connection and tool, nothing stored), every
connection that declares its own App (Open, or Reconnect while signed out) and every agent app (Open its view,
reopening a closed one in the same step, or Manage at `/apps/<name>`). Each source loads and fails on its own; without
agent apps on the deployment the last section is not shown.

The App learns the host context (`lib/host-context.ts`): theme, our tokens as MCP Apps style variables, device,
locale and time zone, its display mode, surface, the modes on offer, and its measured box. MCP Apps also receive
`toolInfo.tool` with the exact exposed tool name (including any connector prefix), its input schema or
`{ type: 'object' }` when unavailable, and its title and description when available. `toolInfo.id` is included only
when the JSON-RPC request id is known; Pi call ids are not request ids. Agent apps receive no `toolInfo`.
The host re-sends the context when its theme or placement changes, retaining the tool information.
On its page the App fills the main column; in its transcript its own height request is bounded (160px to 70% of the
window).

Two more requests are drawn by the host, where the App cannot reach (`lib/app-context.ts`). A link the App asks to
open (https only, no credentials) becomes an offer with a real anchor, so only the owner's click opens it. Context
the App shares for the agent (`ui/update-model-context`, text or structured content rendered as JSON, at most 8192
JavaScript string units) waits in a removable chip above its conversation's composer and travels once, with the
owner's next message there, as `appContext` (`{ app: <App id>, text }`, in the send's `forwardedProps.goblin`) on
`POST /api/conversations/:id/messages`. The
runtime reads where each open App comes from in its registry, never from the browser, and (`pi/content.ts`) appends the
text after the owner's words as a separate block shaped `{ origin: { connectionId | app, trust: 'untrusted' }, appContext }`
(an MCP App's server, or the agent app's name). An agent app's view shares through `share(text)` in its SDK. The persona
treats it as data, never as the owner speaking, and the transcript shows it as a note under their message.

An App's own call to a tool the owner has not granted does not fail at once (`components/apps/grant-ask.tsx`). It
waits on a card the host draws in the App's chrome, naming the exact tool. Allow grants that one tool and runs the
same call again. "Not now", or two minutes without an answer, returns the denial to the App.
