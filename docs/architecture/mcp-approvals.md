# Per-call MCP approval

## Per-call MCP approval

The owner grants a tool under Connections, then can select **Ask first**. This local policy is independent of remote
annotations. Pi's `beforeTool` prepares an encrypted, immutable approval; `mcp_call` records a terminating approval
request. The chat card fetches the owner-bound record and shows its redacted arguments, including public
`operationKey` and asset fields. Approve once dispatches the original arguments; Refuse dispatches nothing.

The shared MCP manager enforces this policy for model, routine, subagent and App callers. Approval binds the endpoint,
grant version, arguments, caller, conversation, task and call id. Current resident authority and execution scope are
checked after connection waits and again at HTTP dispatch. A compare-and-set records dispatch intent once; automatic
OAuth retries cannot reuse it. Reconstruction marks an interrupted dispatch uncertain and never replays it. Routines
release their executing slot while waiting and resume the same run. Direct owner console calls are explicit owner
acts; autonomous App calls to ask-first tools are refused. See [ADR 0028](../adr/0028-mcp-call-approvals.md).

A paid tool of a first-class server can have a **spending rule** ([ADR 0044](../adr/0044-spending-rules-for-paid-tools.md),
`mcp/spend.ts`, `app_mcp_spend_rules`): jobs up to an amount run without asking, until the day's total would pass a
second amount. Amounts are the paid argument's plain decimal read as whole micro-dollars; anything else asks. When the
model's call fits, the hold step (`holdModelCall`) holds it and approves it at once in the owner's name, recording it
against the UTC day in the same transaction that checks the day's total (`app_mcp_spend`), and `mcp_call` sends it
through the approved dispatch above (`sendApproved`) and answers in the same turn. Calls the owner approves on a card
count toward the day too. Only the model's calls in a conversation reach the hold step; agent apps, the Telegram
channel and the skills learner are refused an ask-first tool as before. `mcp_list` tells the model each paid tool's
rule ("asks above $5 a job or past $20 today"). A paid job's approval card (`components/paid-job.tsx`) shows its price
first and largest, the services its plan runs, and the wallet's line with a link to the server's App, and offers
"Approve, and up to $X without asking", which sets the rule as it approves (`ApprovalDecision.runUpTo`; the daily
total stays, or starts at four times the amount). On Connections the paid tool's rule is set or removed
(`GET`/`PUT /api/mcp/:id/spending`), with what it spent today.

A first-class server with its own prepaid balance (`prepaid` on its profile: Mercator's USDC.e on Tempo) is **topped up
from the Goblin Wallet** ([ADR 0049](../adr/0049-prepaid-servers-topped-up-from-the-wallet.md), `mcp/top-up.ts`,
`mcp/fund-job.ts`). Right before its paid tool goes out, from the approved dispatch or the model's own call,
`ensureFunded` reads the server's status as goblin's own work. The status gives the balance in `tokens` and where it is
funded (`depositTo`, from Mercator's `account.walletAddress`). When the balance is short, goblin tops up by the
shortfall rounded up to a dollar, and at least $2, under the owner's top-up rule. The rule is in the spending tables
under the tool key `topup`, by default the profile's $5 a top-up and $20 a day (`GET`/`PUT /api/mcp/:id/top-up`).
- Within it, the top-up is recorded with its destination (`<chain>:<token>:<address>`) under `topup:<connection>:<n>`,
  then sent to the wallet's `transfer` as the MCP caller `funding`.
- The manager lets `funding` reach only the wallet profile's funding tool, and `heldCalls` lets the call out only as
  the record says: amount, chain, token and recipient.
- Above the rule, or without a connected wallet, nothing moves and the job's turn reads what the owner can do.

A wallet that asks the owner first (a new recipient) answers a URL request. It is kept under the job's call, so the
job's card follows to it, and its retry goes again as `funding`. Each top-up that goes out writes an Activity
notification and a chat line ("Moved $5.00 to Mercator from your Goblin Wallet") and a content-free `top_up` flow step.
The server's card shows its balance and the rule with Change (`PrepaidLine`).
