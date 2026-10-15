# OpenUI playground

A public, fixture-driven spike for interactive Goblin replies: hotel comparison with a reactive budget filter,
a trip form, and a weekly dashboard using Goblin's existing chart. The source editor accepts another plain OpenUI
program, and **Replay stream** feeds the real renderer small chunks of the saved program.

This does not call a model. The examples are synthetic. Buttons record their message and values in the page;
they do not send a conversation message, book anything, or call an MCP tool. Reloading resets the examples.

Preview: <https://goblin-openui-spike-preview.kristjan-grm11775.workers.dev>

Try each tab, change the hotel budget or trip details, and press a reply button to inspect its local action receipt.
Use **Replay stream** to see the reply appear incrementally, or edit **OpenUI source** and press **Render code**.
The theme button switches between light and dark.

## Run and check

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd apps/openui-spike dev
heavy bun run check:files apps/openui-spike tools/graph.ts oxlint.config.ts knip.jsonc
heavy bun run --cwd apps/openui-spike test
heavy bun run --cwd apps/openui-spike build
heavy bun run --cwd apps/openui-spike test:browser
```

The browser check starts the built site at a loopback URL and covers a 1440px desktop and a 390px phone, light and
dark themes, partial rendering, form values, filtering, empty results, source editing, invalid input, and reload.
Screenshots and its receipt go to `.local/openui-spike/`. Pass `--url https://<preview>.workers.dev --out <directory>`
to `test:browser` to exercise the deployed artifact instead. Chromium phone emulation is not physical-device evidence.

## Preview deployment

Alchemy owns the independent `goblin-openui-spike` stack. It uses **local state** in this app's `.alchemy/` directory
and a `goblin-openui-spike-<stage>` Worker name. Its only resource is the public static-assets Worker: no D1, R2,
Durable Objects, custom domain, model secret, or bindings to Goblin dev/prod.

With the deployment account's existing credentials in the ignored, mode-600 `.local/cloud.env`:

```sh
cd apps/openui-spike
heavy bun run plan --env-file ../../.local/cloud.env
heavy bun run deploy --env-file ../../.local/cloud.env
```

Both scripts target stage `preview`. Preserve the `.alchemy/` state directory to update or later remove this exact
preview. Do not use Goblin's `deploy:dev`, `deploy:prod`, or shared Cloudflare state store for it. Cleanup, when the
owner is done with the preview, is `alchemy destroy --config alchemy.run.ts --stage preview --env-file
../../.local/cloud.env --yes` from this app's directory.

## Scope and boundaries

- `src/library.tsx` registers ten components backed by `@goblin/ui` and a lazy `@goblin/kit/chart` import.
- `src/program.ts` bounds source size, reports parser errors and unresolved references, and refuses queries,
  mutations, and hosted message bundles. The renderer receives no tool provider or custom executable functions.
- Action output remains data in a local receipt. Even a generated open-URL action never opens a URL.
- Text is React text, with no raw HTML, image or link component. The deployed CSP blocks network connections,
  frames, form submission, and external scripts. Every runtime asset is served by the preview itself.
- OpenUI's automatic development inspector is excluded by using its production entry behavior in this playground.
  Install scripts are not needed. No OpenUI cloud, telemetry consent, or model service is configured.
- OpenUI remains a dependency of this app only. Pi, the main web app, the MCP Apps host and agent-app runtime do
  not import it. Root quality checks include this workspace.

This spike establishes component compatibility and interactive rendering, not generation reliability or a latency
improvement. A subsequent model experiment should measure total prompt/output tokens, successful generations,
time until usable, and client cost against current rich blocks and agent apps. Any integration into conversations
also needs an explicit action/authority adapter, replay/state policy, and readable fallback for external channels.

Sources: [OpenUI React runtime](https://github.com/thesysdev/openui/tree/47514a85963524ad3c73d9158d91e2b3b829a1f5/packages/react-lang),
[benchmark methodology](https://github.com/thesysdev/openui/blob/47514a85963524ad3c73d9158d91e2b3b829a1f5/benchmarks/README.md),
[Alchemy stages](https://alchemy.run/environments/stages/).
