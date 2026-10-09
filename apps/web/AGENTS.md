# Web

Read the root instructions first. Owns TanStack Start, the conversation stream client and the MCP Apps host. No
server secrets reach browser code. Reconnect through a fresh Pi snapshot. Sandbox Apps and validate message
origin/source. Use the local shadcn UI package and keep all runtime calls behind the authenticated API.

## Data layer

Server data goes through the typed API and TanStack Query, after myapps' `docs/agents/ui-data.md` (ADR 0013):

- **Clients.** `lib/api.ts` has `owner` (the agent's `OwnerApi`) and `account` (the Worker's `AccountApi`: billing,
  inbound clients, crash reports). They send `x-goblin-request`, CSRF on every write and, with `withOperation`, the
  operation id. Never `fetch` an `/api` path elsewhere; `lib/boundary.ts` `request()` goes once its last caller does.
- **Factories.** One `src/<feature>/queries.ts` per feature: `owner.apiQuery` / `owner.apiMutation`, keys
  `[feature, kind, input]` naming every input. A mutation's `onSuccess` returns its invalidation promise. A conditional
  read uses `skipToken`, never `enabled` with a placeholder.
- **The `OwnerGate` difference.** goblin has no signed-in layout: owner pages render inside `OwnerGate` (in-page sign-in,
  billing redirect). A route loader primes a read only once the session is known (`lib/prime.ts` `primeOwnerRead`);
  otherwise a signed-out visit's 401 would navigate away instead of showing the in-page sign-in. Inside `OwnerGate`,
  components read with `useSuspenseQuery` inside a `QueryBoundary` (`lib/query/query-boundary.tsx`), so a failed read
  stays inline with its reference and a retry. A section that reads with `useQuery` shows `QueryError`.
- **Streams.** The conversation and workspace SSE stores stay; their events only `invalidateQueries`.
- **Failures.** `messageOf(error, action)` beside the control, `describeError` when behaviour depends on the kind. Both
  quote the reference ("… · ref 7f3a9c12"). A route that fails shows `ReportedRouteError`; only a defect is reported
  to `/api/client-errors`.
- **Tests.** `lib/query/testing.ts` `fakeHttpApi` serves the real contract in memory through an injected `fetch`.
