# Web

Read the root instructions first. Owns TanStack Start, the chat stream reader (AG-UI as server-sent events from the
chat's own endpoint, `lib/agui/`) and the MCP Apps host. No server secrets reach browser code. Every connection opens
with the chat's snapshot, so a dropped, ended or silent stream connects again and starts over; nothing is resumed.
Sandbox Apps and validate message origin/source. Use the local shadcn UI package and keep all runtime calls behind the authenticated API.

A credential's grant (ADR 0114) has one editor, `components/grant-editor.tsx` over the UI package's `GrantTermsEditor`,
used by the install page, Settings' installed and registered apps, the consent page and Settings' MCP clients; `/consent/widen` (`components/widen.tsx`) approves what
a refusal's widening link asks for, and an `access_insufficient` failure shows that link (`WidenLink`). Browser fixtures
(`test/ui-*.ts`) render these screens from source at 1440 and 390px, light and dark, with screenshots under `.local/`.

## Data layer

Server data goes through the typed API and TanStack Query, and the workspace feed writes into the same cache. The
dialect (the clients, `<feature>Keys` and factories, mutations through `context.client`, `useSuspenseQuery` inside
`OwnerGate`, loaders through `primeOwnerRead`, the workspace slices, failures and their reference, tests) is
[docs/agents/ui.md](../../docs/agents/ui.md).
