# Contracts

Read the root instructions first. Only shared runtime-validated schemas and types belong here. Use Effect Schema at
boundaries. No Bun, Node-only or Cloudflare APIs enter this package.

`src/api` is the typed HTTP API ([ADR 0038](../../docs/adr/0038-typed-owner-api-served-by-the-agent.md)): `OwnerApi`
(one group per area, each in its own file, served by the user's agent), `AccountApi` (served by the Worker) and
`errors.ts` (`AppError`, its statuses and the `{ error: { code, message, recovery?, …, ref? } }` envelope). It imports
`effect` only. Keep each endpoint's path, method and success status stable; `error` names the failures the endpoint
itself produces.
