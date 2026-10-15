# OpenUI playground

A public, fixture-driven preview of Goblin’s production reply renderer: hotel comparison,
a trip form, and a weekly dashboard using Goblin's existing chart. The source editor accepts another plain OpenUI
program, and **Replay stream** shows the same code fallback as chat until the fence closes.

This does not call a model. The examples are synthetic. Buttons record their message and values in the page;
they do not send a conversation message, book anything, or call an MCP tool. Reloading resets the examples.

Preview: <https://goblin-openui-spike-preview.kristjan-grm11775.workers.dev>

Try each tab, change the trip details, and press a reply button to inspect its local action receipt.
Use **Replay stream** to see an unfinished fence become an interactive reply, or edit **OpenUI source** and press **Render code**.
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
dark themes, streaming fallback, form values, option selection, source editing, invalid input, and reload.
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

The preview imports `@goblin/web/replies`: the same `ChatMarkdown`, OpenUI component library, validation and action
message builder used by the real app. There is no second renderer. Its `ReplySend` adapter records the exact text
locally instead of calling the owner API. The main app uses the containing conversation's normal send hook.

Text stays React text; there are no HTML, image or URL components, executable actions, functions, queries or
mutations. The deployed CSP blocks network connections, frames, native form navigation and external scripts.
OpenUI's automatic development inspector is disabled by the checked package patch, and renderer observability is
off. Every runtime asset is self-hosted. The Alchemy build includes web source in its memo inputs.

This preview demonstrates rendering and action-message construction. It does not establish model-generation
reliability, latency savings, tool execution or authenticated deployment behavior. See
[chat blocks](../../docs/architecture/chat-blocks.md) for the integration and its state/authority policy.

Sources: [OpenUI React runtime](https://github.com/thesysdev/openui/tree/47514a85963524ad3c73d9158d91e2b3b829a1f5/packages/react-lang),
[benchmark methodology](https://github.com/thesysdev/openui/blob/47514a85963524ad3c73d9158d91e2b3b829a1f5/benchmarks/README.md),
[Alchemy stages](https://alchemy.run/environments/stages/).
