# Development

Requirements are Bun `1.4.2` and Node.js 22. From the repository root:

```sh
bun install --frozen-lockfile
mkdir -p .local
cp .env.example .local/local.env
chmod 600 .local/local.env
bun dev                 # local Alchemy/workerd stage
bun run check           # full repository gate
bun run build
```

Before starting, set `PURRABLE_OWNER_EMAIL` and replace `PURRABLE_BETTER_AUTH_SECRET` and
`PURRABLE_OWNER_BOOTSTRAP_TOKEN` in `.local/local.env`. Local model calls inherit `CLIPROXY_API_KEY` from the
interactive shell; set `PURRABLE_MODEL_KEY` only when explicitly overriding it. The local CLIProxy must be reachable
at the configured base URL. In the browser, use **Create owner and sign in** with the configured owner email, a new password,
and the local bootstrap token; subsequent visits use **Sign in**. The runtime rejects additional owner registration.

Useful focused commands are `bun run test:unit`, `bun run test:integration`, `bun run typecheck`, `bun run effect:check`, `bun run lint:gate`, `bun run compatibility:check`, and `bun run check:files <paths>`. Run expensive commands through `heavy`; exit 75 means another heavy job is running.

The stage wrapper owns environment loading and refuses unsupported stage names:

```sh
bun run plan:dev
bun run deploy:dev
```

Both dev commands require the private mode-600 files used by `scripts/stage.ts`. Do not print or commit them. Deployment is Alchemy only; production promotion is outside this repository handoff.

Run `bun run smoke:dev` for authorized retained-dev acceptance using the provisioned owner credentials in
`.local/dev.env`. It verifies MyPlan/MyBrowser read capabilities and one resident Pi MyPlan call, then emits a
sanitized receipt. See [the operator script guide](../scripts/README.md) for the exact scope and prerequisites.

Application SQL migrations are bundled under `apps/runtime/migrations` and applied by the Alchemy D1 resource. Do not run migrations against a production database. Durable Object application metadata is created by the runtime migrator and remains separate from Pi and Agents tables.

The UI configuration is in `packages/ui/components.json`. Add a shadcn component from that workspace with `bunx shadcn@latest add <component>` and review the generated file before staging. Add a dependency with `bun add <package> --cwd <workspace>`; commit `package.json` and `bun.lock` together through the coordinator. Generated route code is produced by TanStack tooling; do not hand-edit `apps/web/src/routeTree.gen.ts`.

Add a workspace only for an existing app or shared boundary, under `apps/` or `packages/`, with a package manifest,
strict `tsconfig.json`, declared check tasks, and a short `AGENTS.md`/`CLAUDE.md` shim. Run `bun install` to update the
lockfile, then `bun run graph` to check that every file has an authoritative project. Turbo schedules declared tasks;
it does not replace Bun's workspace dependency ownership.

Cloudflare platform APIs use the pinned `@cloudflare/workers-types` dependency. Binding declarations are explicit in
`apps/runtime/src/env.ts` and are checked against runtime use; update them alongside `apps/web/alchemy.run.ts` when
changing bindings. There is no generated Wrangler binding file or second infrastructure configuration to regenerate.
Refresh platform declarations by updating that pinned dependency and lockfile together, then run `bun run typecheck`.

If a command fails, first inspect `git status` and identify whether the failure is in a file you own. A red check in another agent's dirty file is not evidence that this change is broken. Local workerd, unit tests, provider probes, and a retained dev deployment are separate evidence classes; do not report one as another.
