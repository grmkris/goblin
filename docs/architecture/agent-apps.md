# Agent apps

## Agent apps

The agent builds apps for the owner (ADR 0021): small programs with durable JSON state whose actions and views it
calls with `app_call`. `app_build` takes an app's files (`app.ts`, up to five more, TypeScript, importing only `@goblin/app` and
each other); `agent-apps/build.ts` transpiles them with sucrase in the toolchain's own Dynamic Worker, runs the
release's `describe()` in the release's isolate, checks the manifest (`agent-apps/manifest.ts`: names, schemas of the
`s.*` subset, `initial` fitting `state.schema`), and on an upgrade keeps the state when it fits the new schema or
runs `state.migrate`. Only then does the release become active, as one transaction (`agent-apps/store.ts`); a failed
build is kept with its problems and changes nothing that runs. Every app release, the transpiler and `code_run` run
through `agent-apps/isolates.ts` over the `LOADER` binding: no network, no bindings, a CPU limit, at most eight calls
at once, and wall timeouts. A deployment without it (`GOBLIN_AGENT_APPS=off`, ADR 0064) gives the agent no app or
`code_run` tools, refuses any isolate (`Forbidden`, `agent_apps_unavailable`) and drops Apps from the rail.

A call (`agent-apps/dispatch.ts`) checks its input against the member's schema; an action's `prepare` runs once
with a read-only state snapshot and the app's powers (its own files in Shell's namespace `app_<name>`, a log line),
then, holding the app's lock (the agent runtime's `KeyedLock`, one key per app, first come first served), `run` reads
the current state and returns the next, which is checked and committed as one revision with the operation's receipt.
The owner's paths hold that lock in the runtime (`agent-apps/live.ts`); Pi's tools, job alarms and an isolate's calls
take the same lock through the bridge's `run`. A replayed operation id returns its receipt. The agent calls every app through
one typed tool, `app_call(app, member, input)` (`agent-apps/toolset.ts`, ADR 0027), so the tool list stays the same
whatever apps exist and a build leaves the prompt the provider caches alone; an action the app keeps for its view is
refused, and a state or value over 8 KB comes back as a valid summary (its size and fields). The `<apps>` part of the
trailing context block lists each app's members with their typed inputs. A call pins the release it began on
(`goblin.release` memo) and refuses to run on newer code. Subagents and routine runs set their own exact extension
lists and get no `app_call`. `goblin.apps` (`pi/apps.ts`) offers `app_docs`, `app_build`, `app_inspect`,
`app_rollback` and `code_run`. The SDK, release entry, transpiler and
docs are `packages/app`, built into `dist/toolchain.js` (loaded only while building).

An app with a `view.tsx` has a UI (`packages/app/docs/ui.md`). The transpiler makes the view one CommonJS module with
React's automatic JSX runtime and refuses imports the frame does not provide; the style compiler (Tailwind's, with
goblin's theme, in its own Dynamic Worker) compiles exactly the classes the view uses. Both are kept per release
(`app_agent_views`). Before a release activates, the render check (`packages/app/src/render.ts`, a Dynamic Worker
with the view as its CommonJS module and a shim for each import) renders the view once with the state the release
starts with, goblin's components for real, and charts, maps, diagrams and
icons as stand-ins. A view that throws fails the build with its line of `view.tsx` and changes nothing that runs;
one that reads a browser-only global while rendering, or a check that did not run, activates with `viewWarning`.
The first release with a view adds the app to the App
registry under its home conversation
(`apps/registry.ts`), and every revision after that reaches the workspace feed. The web host loads it like an MCP App,
in the same double sandbox (`lib/app-sandbox.ts`): a document of goblin's stylesheets, the app's own, and its module,
over the frame bundles from `packages/app/dist/runtime` (React, the UI SDK and goblin's components in `core.js`;
charts, maps, diagrams and icons only when the view imports them), served as hashed assets. The frame has no network
(`connect-src 'none'`); it loads scripts from goblin's origin only, and tiles from OpenStreetMap only for maps. The
bridge (`lib/agent-app-bridge.ts`) sends the state as tool results carrying `goblin/state` (the newest revision wins),
routes the view's action calls to `POST /api/apps/:id/call` with the frame's operation id (the agent keeps it as
`ui:<app>:<uuid>`), and reports the view's failures, which the agent sees in its `<apps>` list and in `app_inspect`.
The frame (`components/apps/frame.tsx`) makes those calls through the factories in `apps/queries.ts`, which also carry
an MCP App's own tool calls and resource reads to its server with `x-mcp-caller: app`. The frame's first script
keeps errors from before the core runs (a bundle that throws as it loads or never arrives), a view import whose bundle
failed names that bundle, a view module that throws shows the error card instead of a blank frame, and failures that
come together go out as one notice once the frame is connected (`packages/app/src/ui/core.ts`, `sdk.ts`). A bundle's
own message reads "Script error." because the frame is a different origin from the bundles. A new release reloads the
frame; a new revision is pushed into it. In the transcript the view shows under the newest build of it with one.
Inline agent app views have a borderless host surface and a quiet toolbar for page and close controls; the view
owns its canvas styling. External MCP Apps retain their framed host surface.

Beyond its state and files, an app reaches only the powers it declares and the owner approves (ADR 0021):
`ctx.fetch` to exact `egress` hosts (`agent-apps/egress.ts`: https on 443, never the deployment's own host or anything
under it, so a deployment on a shared platform domain leaves its neighbours reachable; redirects checked
again, no cookies, bounded), and through the agent (`agent-apps/ports.ts`, lent by `agent.ts` with the engine, each call entering it
through the bridge's `run`) the owner's MCP
tools under their exact grants, the cheap model within the owner's budget, a message to the owner through Notify me via
(`ctx.notify`, ADR 0070: the sink's template filled with the words as written and the call's operation id, resident
authority and the sink checked again right before it leaves, and an app error that says so with no sink set), and other
apps' actions and views (`agent-apps/reach.ts` composes each `prepare`'s `AppPowers`). Every use checks the approval
(`app_agent_powers`), the app's daily cap (`app_agent_usage`) and, for what goes through the agent, resident
authority. A build lists the powers still waiting; the web draws them as a card under it
(`components/parts/app-powers.tsx`). A view offers files to save through the host's download offer. The agent looks
for MCP servers with `mcp_suggest` and asks the owner to add one with `mcp_request_server` (`pi/servers.ts`), a card
whose Add and connect runs the usual flow.

An app's `schedules` run its actions on their own (`agent-apps/jobs.ts`): one `app_agent_jobs` row and one dated
native schedule (`runAppJob`) per scheduled action, reconciled when a release activates or rolls back and when the
agent object starts. A job is an ordinary call with its own operation id; it catches up only the newest missed slot,
backs off after failures and pauses after ten, and waits while resident authority lapses. Each app's schedules ride
the workspace feed (`AgentAppSource.jobs`) to the App's bar.
