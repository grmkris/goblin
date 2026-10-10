# Effect in the runtime

Read `node_modules/effect/AGENTS.md` (Effect 4.0.1's own guide) and the
[effect-4 skill](../../.agents/skills/effect-4/SKILL.md) first. This page is the runtime's rules for where Effect
starts, how work is serialised and how areas talk.

## Two ways into Effect

Programs are Effects composed with other Effects. Code outside the runtime enters through exactly one of two doors.

- **The bridge** (`runtime/bridge.ts`), for code the runtime does not own: Pi kits, the agent-apps engine and its
  Dynamic-Worker powers, Durable Object alarms and `deleteAgentData`. `agent.ts` hands the bridge to each of them when
  it builds them; `AgentInput` does not carry it. `run` checks the account's plan first, `local` does not, and `exit`
  answers the exit.
- **`promiseWith(context)`** (`runtime/boundary.ts`), for a foreign callback wired inside a layer that must answer a
  Promise: the MCP SDK's auth provider (`token`, `onUnauthorized`) and dispatch guards, and the skills guard. The layer
  captures its context once (`Effect.context()`) and runs the callback's Effect with it. It rejects with the typed
  failure itself, so an `AppError` crosses the SDK unchanged.

A program calls neither, and never `Effect.run*`: it composes. An import allowlist enforces both doors.

## Services and layers

- A service is a `Context.Service` in `<area>/service.ts`, its methods `Effect.fn('Service.method')` with typed
  `AppError` failures. A synchronous Drizzle store is a plain function over `Db`, wrapped once where its service is
  built. A multi-statement invariant stays inside one transaction or one `Effect.sync`.
- `layers/core.ts` provides `AgentInput`, `Db`, `Changes`, `PiSessions`, `KeyedLock`, `SingleFlight`, `FlowEvents`,
  `Entitlements`, `Resident`, the logger and the reporter. Each area's layer sees only the layers before it, in the
  order `layers/index.ts` gives; that order and the start's steps are the boot contract.
- A stateful object is made once, by its layer, and shared as a service; never a second instance.
- Pi is reached through `PiSessions` (`pi/sessions.ts`): every call names its session, failures are a typed
  `PiFailure`, and interrupting a `wait` ends only the wait.

## Serialising work

- **`KeyedLock`** (`observability/lock.ts`) admits one holder per key, first come first served: a chat's lock, a
  thread operation (`thread-op:<op>`), the app lock. It is held for admission only, never across a network or model
  wait. Effect's `Semaphore` is not FIFO; use it only where order does not matter (the Telegram pull's
  `Semaphore(1)`).
- **`SingleFlight`** (`observability/single-flight.ts`) runs one keyed piece of work at a time across waits: a token
  refresh, a connect, a move's remaining steps, a title being named. `run(key, effect)` joins the run in flight or starts
  it in the layer's scope, so interrupting the first caller does not cancel it; `skip(key, effect)` answers at once when
  one is in flight.
- A promise map or a `#running` set in a service is one of these, written by hand: use the primitive.

## Changes, not listeners

An area tells others about a write through `Changes` (`runtime/changes.ts`): it declares its topic by module
augmentation of `ChangeTopics` where it publishes it, named `<area>.<event>`, with ids as the payload, never content. A
handler runs inline and must not wait. A listener set on a service is a change topic, written by hand.

## Logs and failures

Lines go only through `observability/logger.ts` (`logEvent`, `Effect.log*`, `writeLine`; closed `LOG_EVENTS`,
allowlisted keys). A failure is reported with `reportFailure(where)` or `reportAndRecover(where, fallback)`
(`observability/report.ts`); an expected one is marked with `expectedFailure`. Flow steps go through
`FlowEvents.record` or `withFlow`. Nothing carries content: no message, cause or field holds what the owner or the
model wrote (ADR 0024).
