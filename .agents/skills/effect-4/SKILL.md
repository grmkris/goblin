---
name: effect-4
description: Write or review Effect 4 services, layers, schemas, errors, and diagnostics in goblin. Use before changing runtime composition or Effect code.
---

# Effect 4 in goblin

Use the installed Effect 4 guide and declarations as the API authority. Verify the pinned version and imports before relying on memory.

- Use Context services, Layers, typed tagged errors, Schema at external boundaries, and scoped resource lifetimes.
- Keep pure transformations as ordinary functions; wrap platform I/O, retries, timeout, concurrency, and observability in Effect.
- Match errors with `catchTag` or `Match`; do not hand-compare `_tag` values or throw global `Error` from Effect failures.
- Use Effect platform services for HTTP, clock/date, random, crypto, logging, timers, and configuration. `process.env` is configuration input only where a documented tooling exception allows it.
- Do not hold a Durable Object transaction, lifecycle gate, or lock across network/model calls, timers, or waits.
- Keep Pi Durable state and vendor tables outside application Effect services; application services own only goblin contracts and `app_*` data.
- Run `bun run check:files <owned paths>` after edits. Run the root Effect diagnostics gate before handoff.

## The runtime's shape

- A service is `class X extends Context.Service<X, { …methods returning Effect… }>()('goblin/<area>/X')` in
  `<area>/service.ts`, its methods `Effect.fn('X.method')` with typed `AppError` failures. A synchronous Drizzle store
  stays a plain class or function, wrapped once where its service is built. Keep a multi-statement invariant inside one
  transaction or one `Effect.sync`, never spread across `yield*`.
- Layers: `layers/core.ts` (`AgentInput`, `Db`, `Changes`, `PiSessions`, `KeyedLock`, `FlowEvents`, the logger and
  reporter), then the start's steps and one layer per area in the order `layers/index.ts` gives; each sees only the
  layers before it, and the start's order is the boot contract. `AgentServices` is derived from them. A stateful
  object is made once, by its layer, and shared as a service (never a second instance); programs use the services.
- Programs compose; a program's requirements are inferred, never written out to dodge a type cycle. Code outside the
  runtime (Pi kits, alarms, the apps engine) runs programs through the bridge `agent.ts` hands it (`runtime/bridge.ts`):
  `run` checks the plan, `local` does not, `exit` returns the exit. Never call `run`, `local` or `Effect.run*` inside
  an Effect. Only the files `tools/graph.ts` lists may import the bridge or `promiseWith` (`boundaries/no-closed-import`).
- Owner API handlers are `HttpApiBuilder.group` programs in `<area>/api.ts` over the contract in
  `packages/contracts/src/api` (ADR 0038). Imports have no `unstable/` segment: `effect/http-api/HttpApi`,
  `effect/http/HttpRouter`.
- Locks: `KeyedLock` (`observability/lock.ts`), first come first served, for admission only; Effect's `Semaphore` is
  not FIFO. Cross-area notices go through `Changes` (`runtime/changes.ts`): declare a topic by module augmentation of
  `ChangeTopics` where you publish it, with ids as the payload.
- Logs and failures: lines only through `observability/logger.ts` (`logEvent`, `Effect.log*`, `writeLine`; closed
  `LOG_EVENTS`, allowlisted keys); never put content in a message, a cause or a field (ADR 0024). Report a failure
  with `reportFailure(where)` or `reportAndRecover(where, fallback)` (`observability/report.ts`); mark an expected one
  with `expectedFailure`. A catch-all that drops a failure says why: `// expected: <reason>`.
- New Effect code reaches Pi through `PiSessions` (`pi/sessions.ts`): every call names its session, failures are a
  typed `PiFailure`, and interrupting a `wait` ends only the wait.

This skill proves source-level conventions only; it does not prove Cloudflare lifecycle behavior or provider reachability. Read the current official Effect 4 docs and installed `node_modules/effect/AGENTS.md` when APIs are uncertain.

Adapted from `grmkris/myapps@54259fdd5a2560d2595167d7ff0650826a039102`, `.agents/skills/effect-in-myapps/SKILL.md`,
reviewed 2026-10-04. goblin replaces app-specific MCP/storage paths and adds its native Pi/Drizzle ownership
boundaries and its runtime's shape. Source hash, internal-reuse authorization and adaptation details are recorded in
`sources.json`.
