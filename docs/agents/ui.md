# Web data

The web holds server data in one place: TanStack Query (5.104), filled through the typed API. This is goblin's dialect
of My Apps' `docs/agents/ui-data.md` (ADRs 0013, 0038); [lint quality](lint-quality.md) lists the rules that enforce its
transport boundary.

## Clients

`lib/api.ts` has the clients: `owner` (the agent's `OwnerApi`), `workspaceAccount` (the Worker's
`WorkspaceAccountApi`: a workspace's keys and members) and `account` (the Worker's `AccountApi`: workspaces, inbound
clients, crash reports). `lib/api-grants.ts` holds two more for release A's grant endpoints (ADR 0114) until the Worker's
own APIs carry them: `grantsAccount` (`GrantsGroup`: the consent and widening pages' terms, and saving them) and
`keyTerms` (a key made and changed by its grant's terms). Each request carries `x-goblin-request`, the CSRF header on
every write and, with `withOperation`, the operation id. A call under a workspace goes to the page's own unless it is
wrapped in `inWorkspaceOf(slug)`: a person's own page (the consent page) reads each of their workspaces that way. Nothing else calls the server, except four transports: the owner's file bytes
(`lib/files.ts`), the live reads in `lib/event-streams.ts` (a chat's AG-UI stream at the URL its join answered, read by
`lib/agui/reader.ts`, and the workspace stream, opened by `WorkspaceFeedProvider`, `components/workspace-feed.tsx`, over
`BrowserFeedSource` and kept by `lib/workspace/`) and Better Auth's client. Untyped values (stream frames, App messages, tool payloads) are read with `lib/values.ts`, never
decoded as API answers.

## Factories and keys

Each feature has `src/<feature>/queries.ts`, which holds factories only: `owner.apiQuery` and `owner.apiMutation`
options, and the feature's keys. Hooks that read or combine them live in `src/<feature>/hooks.ts` (the session in
`auth/hooks.ts` `useSession`, adding and connecting a server in `mcp/hooks.ts` `useAddAndConnect`); components never
build query options inline.

Keys come from one `<feature>Keys` object whose root is the feature's name, and name every input:

```ts
export const topicKeys = {
  all: ['topics'] as const,
  detail: (id: number) => [...topicKeys.all, 'detail', id] as const,
}
```

A conditional read uses `skipToken` with the absent input in its key, never `enabled` with a placeholder.

## Mutations

A mutation factory is a value, not a function of a `QueryClient`. Its callbacks take TanStack's
`MutationFunctionContext` and reach the cache through `context.client`, so no component calls `useQueryClient` to
build one:

```ts
export const createTopicMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, topic: CreateTopic) =>
      api.topics.create({ payload: topic }).pipe(withOperation(topic.operationId)),
  }),
  onSuccess: (_topic, _input, _result, { client }) => client.invalidateQueries({ queryKey: topicKeys.all }),
})
```

`onSuccess` returns its invalidation promise, so the mutation stays pending until the reads it changed are fresh. Every
write goes through a mutation (it reaches the mutation cache's `onUnauthenticated`), never a bare `run`. An optimistic
change is `onMutate` with its rollback in `onError`.

## Reads and the gate

goblin has no signed-in layout. Owner pages render inside `OwnerGate` (the web component: sign-in on the page), which
decides whether the visitor signs in first. Inside it, a component
reads with `useSuspenseQuery` within a `QueryBoundary` (`lib/query/query-boundary.tsx`), which keeps a failure inline
with its reference and a retry. Only an optional section reads with `useQuery` and shows `QueryError`.

A route loader primes a read only through `primeOwnerRead` (`lib/prime.ts`). It runs ahead of the gate and decides
nothing: it does not wait for the session, sends no one to sign in on a refusal (`auth: 'optional'`), drops a refused
read nothing watches yet, and primes nothing on the server.

## The workspace

`lib/workspace/` is the one module that keeps the agent's workspace in the cache, fed by the workspace stream. Each
slice has its key, `workspaceKeys.slice(name)` (`['workspace', name]`): conversations, activity, apps, topics,
personas, invocations, receipts and notifications. The slices never go stale and are never collected (`setQueryDefaults` on
`['workspace']` with `staleTime` and `gcTime` at `Infinity`); `['workspace', 'status']` holds what is wrong with the
feed.

- **Reads.** A slice's `queryFn` waits for the connection's first snapshot, so an owner page can suspend on it; after
  that the stream writes each changed slice with `setQueryData`, and a reconnect's snapshot replaces them all.
  `activity` is a plain record keyed by chat, so structural sharing keeps every unchanged entry.
- **Hooks.** `useConversations(select)`, `useConversation(id)`, `useActivities(select)`, `useActivity(id)`,
  `useApps(select)`, `useTopics`, `usePersonas`, `useInvocations`, `useReceipts` and
  `useFeedStatus`
  (`lib/workspace/hooks.ts`). Read through a `select`, so a component renders again only when its part changes.
- **Writes.** A workspace write is a mutation in `lib/workspace/mutations.ts` that shows the server's answer through
  `applyWorkspaceChanges` before the stream repeats it. Closing an App shows at once and rolls back on a refusal; the
  close still on its way (found in the mutation cache by `workspaceKeys.apps`) is applied again over every stream write
  and every reconnect's snapshot.
- **Other reads.** A workspace change that makes another feature's reads stale invalidates them through the module's
  one map (`staleAfter`, `lib/workspace/invalidations.ts`); no component bridges the feed and Query itself.

A chat's stream ([chat streams](../architecture/streams.md)) is read beside the cache: `lib/agui/reader.ts` connects
to it (`chatStream`, `lib/event-streams.ts`, a `fetch` of `GET /api/conversations/:id/stream` under the page's
workspace) and reads its AG-UI events, starting over at each connection's opening, `lib/agui/reducer.ts` folds them
into the transcript's projection, and `lib/stream-pool.ts` shares one reader per chat among the panes that show it. It holds no
owner data that a query also holds; older pages come from the history query, in the same message mapping. A stream
refused for good (401) goes to sign-in through the query client (`failedOutside`, `lib/query/api-query.ts`).

## Failures

`messageOf(error, action)` gives the copy beside the control that failed, and `describeError` the failure's kind (and
its `ref`) when behaviour depends on it. A page's own words for a failure it expects ("that name is taken") go through
`withRef(text, error)`. All of them end with the reference ("… · ref 7f3a9c12") through one builder in
`lib/query/app-error.ts`. A route that fails shows `ReportedRouteError`; only a defect is reported to
`/api/client-errors`. An answer's reference is read in one place, `answerRef` (`x-goblin-ref`, else cf-ray); without
an answer the failure quotes the request's own `x-goblin-request` id. Better Auth and `/health` answer outside the
typed API: `auth/queries.ts` sends each call's `x-goblin-request` id and turns a refusal or silence into `AuthRefused`
carrying that reference, which `messageOf` and `withRef` quote like any other.

## Tests

`test/query/testing.ts` `fakeHttpApi` serves the real contract in memory through an injected `fetch`, and
`testQueryClient` gives a fresh cache. A fake group answers what the test calls and nothing else:
`handlers.handleAll({ ...unusedHandlers(OwnerApi.groups.mcp), approval: … })` (`test/query/unused-handlers.ts`) gives every other
endpoint a handler that dies, so a new endpoint needs no line in the test. Browser fixtures render inside a
`QueryClientProvider`.
