# Contracts

Read the root instructions first. Only shared runtime-validated schemas and types belong here. Use Effect Schema at
boundaries. No Bun, Node-only or Cloudflare APIs enter this package.

`src/api` is the typed HTTP API ([ADR 0038](../../docs/adr/0038-typed-owner-api-served-by-the-agent.md)): `OwnerApi`
(one group per area, each in its own file, served by the user's agent), `AccountApi` (served by the Worker),
`InternalApi` (`internal.ts`, what the Worker calls on the agent for anyone but the owner's browser; exported only from
`@goblin/contracts/internal`, which the web may not import) and `errors.ts` (`AppError`, its statuses and the
`{ error: { code, message, recovery?, …, ref? } }` envelope). It imports `effect` only. Ids shared across areas
(`ChatId`, `AppId`, `EntryId`, `TopicId`, `PersonaId`, `OperationId`, `NonEmptyString`) live once in `src/ids.ts`.
Keep each endpoint's path, method and success status stable; `error` names the failures the endpoint itself produces.
