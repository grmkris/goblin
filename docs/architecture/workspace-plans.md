# Chat-driven setup

The owner can ask Goblin to compose existing Sources and routines in a **workspace plan**. The agent discovers MCP
connections, tools, events and enabled skills, organizes Topics and Personas with the existing tools, then proposes
the Sources and routines together with `workspace_propose`. No provider-specific setup logic lives in the browser or
runtime. Named `mcp_list` tools expose their advertised output schemas so the agent can derive Source pointers and
reply-result rules.

`WorkspacePlanProposal` (`packages/contracts/src/workspace-plans.ts`) holds a title, purpose and up to eight Sources
and eight routines. `workspace-plans/program.ts` prepares their existing proposals under stable operation ids. The
plan keeps their exact review snapshots and the revisions of the Topics they use in `app_workspace_plans`. Preparing
grants nothing and activates nothing. Repeating the same operation finds the same plan; different content under that
operation is refused.

A preparation failure keeps the plan in `preparing` with a content-free failure code. The chat still shows its card;
Retry preparation calls the owner API and repeats the same primitive operation ids, without activating anything.
After preparation succeeds, activation needs a separate click on the complete review.

The chat renders a native review card whose contents come from the authenticated owner API, not from tool text.
Activation is available only to the owner API (`POST /api/workspace-plans/:id/apply`), with the reviewed revision.
It checks the plan, Topics and primitive revisions, then calls the existing Source and routine confirmation paths.
Their grant checks, event subscriptions, Ask first policies and delivery-result handling remain authoritative.
Topic revisions are checked again between steps, since an earlier confirmation can wait on a remote server.

Progress commits after each completed primitive. A later failure leaves earlier configuration in place and changes
the plan to `attention`; Continue setup retries the remaining steps. An interrupted application can be continued
from its stored progress. This is partial application, not an atomic transaction across remote servers. An operation
that already completed is recognized through the existing primitive's state and operation receipt.

After activation, `workspace-plans/continuation.ts` submits a status to the original chat through
`ChatOperations.send`, under one stable operation id and a system-authored `workspace_setup` receipt. Goblin can then
verify the connection or explain the remaining steps. A budget or missing-model refusal keeps the result as a passive
`app.workspace_setup` entry, read with the owner's next message. A failed continuation leaves the configuration
applied and the card offers Continue setup. `workspace_status` reads the durable review and progress.

The plan records a setup attempt; the resulting Sources, routines, Topics and Personas keep their existing lifecycle
and management UI. Pi continues to own conversations and execution. The browser only reads the plan and sends an
owner decision.

## Evidence and current boundaries

The focused tests in `apps/runtime/test/workspace-plans.test.ts` exercise the real SQLite baseline and plan/routine
stores with controlled Source and scheduler ports: no activation during preparation, operation identity,
reconstruction, partial retry, stale reviews, revoked authority, concurrent activation and continuation budget
fallback. They do not establish a live provider subscription or delivery.

`test/integration/workspace-plans-case.ts` exercises the proposal tool through Pi and the real signed-in owner API,
with native SQLite, two-account isolation, CSRF refusal, exact revision checks, routine activation and continuation.
Its model is deterministic. The browser fixture checks review and recovery at 390px and desktop widths.

`ready` means the reviewed configuration was applied. It does not mean a Telegram message was received or delivered.
Connections and OAuth still use the existing MCP connection cards; this plan is created after prerequisites have
been discovered, not before sign-in.

Shared-group participant authority and private-context isolation are not implemented by this composition. Sources
still admit only messages matching the owner's confirmed speaks-for-me rule; other messages are notices or dropped.
Topics are not privacy boundaries: retrieval can search other Topics. A shared conversation must not be presented as
isolated, and setting every participant to speak for the owner is not a substitute for participant permissions.
