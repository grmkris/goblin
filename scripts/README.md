# Operator scripts

Deployment scripts use Alchemy only. Secrets are read from the operator environment and are never printed.

Run the manual retained-dev smoke with `bun run smoke:dev`, equivalent to:

```sh
bun --env-file .local/dev.env scripts/smoke-dev.ts
```

The mode-600 configuration must set `PURRABLE_STAGE=dev`, the retained HTTPS `purrable-dev.*.workers.dev`
`PURRABLE_APP_URL`, and the provisioned `PURRABLE_OWNER_EMAIL`/`PURRABLE_OWNER_PASSWORD`. The helper signs in;
it does not register or bootstrap an owner. It refuses other targets and verifies the configured MyPlan and
MyBrowser dev endpoints before creating exact one-hour tool grants for `myplan_open` and `browser_backends`.

This explicitly invoked smoke makes bounded read-only MCP calls and one resident Pi submission. It verifies a
new committed assistant tool call, its successful `pi.tool-result`, and the assistant completion marker. Credentials,
cookies and response bodies stay in memory. The printed receipt and `.local/smoke-dev-receipt.json` contain only
statuses, operation ID, negotiated versions, capability names, counts, booleans and a transcript hash. Grants expire
after one hour. The helper is not a CI check and must not be run without authorized retained-dev acceptance.

Outbound MCP access tokens may expire before these grants. A 401 connect result needs fresh private dev credentials
and an Alchemy binding update before retrying; see [the compatibility record](../docs/mcp-compatibility.md).

Browser rendering, sandboxed MCP App initialization and a permitted App interaction remain separate real-browser
acceptance checks; this helper does not establish them.
