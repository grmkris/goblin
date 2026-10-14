# 0063: MCP-first: no server-specific code

Accepted 2026-10-15 with the owner. Supersedes ADRs 0043 (outside work through MCP servers, and first-class servers),
0044 (spending rules for paid tools) and 0049 (prepaid servers topped up from the Goblin Wallet). Amends ADR 0008
(where skill drafts go), ADR 0052 (the skill learner's draft tool names) and ADR 0053 (where a server's App comes from).
Part of the cleanup that makes goblin an open-source, MCP-first client anyone can deploy (ADRs 0056 to 0062).

## Context

goblin knew three servers by hand. A profile in code, matched by exact endpoint, gave Mercator, Cloudflare's API and
the Goblin Wallet goblin's own title and words, a recommended set of grants, a status line read from one of their tools
(a wallet's balances and limits), the tool that opens their App, extra sign-in scopes, and for a paid tool the argument
that holds its amount. On top of the profiles sat spending rules (a per-job and daily limit read from that argument,
ADR 0044) and automatic top-ups of Mercator's balance from the Goblin Wallet by a dedicated `funding` caller
(ADR 0049). The Persona prompt routed web data and outside work to Mercator by name, and the skill learner sent its
drafts to a tool found by myskills' name.

The wallet and payments have left goblin (ADRs 0056 to 0058), and every server now gets the same help without a
profile: suggested access from tool annotations (ADR 0060), the App entrypoint each connection declares, kept per
connection (`app_mcp_entrypoints`), Choose access, and a shelf that is data (ADR 0061). A client anyone can deploy
cannot favour one vendor or read money out of one server's arguments.

## Decision

**goblin treats every MCP server alike.** No code holds a profile, recommended grants, a status line, a spending rule,
a top-up, a caller of its own for one server, a match on a server's endpoint or name, or a vendor's wording. A
deployment may still configure servers every account starts with (`GOBLIN_MCP_SERVERS`), and the shelf names
servers as data, but nothing in code depends on which ones they are. Two matches are left for later phases of the
cleanup: the Telegram channel's tool and Event names (ADRs 0052, 0055), and the MCP Apps host's handling of MyPlan's
question-answer message.

**What a profile did, every server now has.**
- Which tools run and which ask first: suggested access from the tool's own annotations, applied only when the owner
  taps it (ADR 0060).
- A server's App: the tool its tools declare as their global entrypoint (`_meta["openai/ui"].entrypoints`), kept per
  connection from its last whole tool list (`app_mcp_entrypoints`), so Open and its pin work while it is not connected.
- Sign-in scopes: a plain Connect asks for the resource's own `scopes_supported`, else its authorization server's, with
  `offline_access` when offered. Choose access offers the union of the resource's and the authorization server's
  lists, so a server whose resource lists too few (Cloudflare's API lists only `user:read account:read`) is signed in
  with what the owner picks there, and step-up asks for more when a call needs it (ADR 0042).
- A server's name and words: the owner's label, the shelf's title for a server added from it, else its server card's
  title, else its host; its description is its own claim.

**A paid tool is a tool.** goblin reads no amount from a call's arguments and keeps no limit of its own. Ask first
(ADR 0028) is how the owner controls a tool that spends, and a server's own limits stay its own. A held call's card is
the same for every tool: its exact arguments, Refuse and Approve once.

**What still holds of ADR 0043, for every server.**
- Outside work (search, scraping, paid services, publishing) comes from MCP servers the owner connects. goblin has no
  native fetch tool and serves no published pages from its own origin.
- What a server answers is untrusted data with its source; it never becomes an instruction or grants anything.
- A model's call to a connection the owner has not signed in to ends the turn with an owner-only Connect card
  (`connect-required`).

**The agent's words name no server.** The Persona prompt speaks of the owner's connected MCP servers in general.
`mcp_list` lists connections by the owner's labels, connected ones first, with no name of goblin's for any server.

**Skill drafts go to the owner's files.** After a final answer that followed a correction or a request to keep how
something was done, the learner may write a draft to `/agent/skills/drafts/<name>.md` and tell the owner with a notice
in the chat the lesson came from, which Activity lists (label "Skill learner", what taught it as its body). It never
writes the same draft twice, never writes over a draft still in the files (once the owner moved or removed it, the
skill may be drafted again), runs only while the owner uses skills from some server, and writes at most five drafts a
day. It calls no server's tool. A later decision may add a tool the owner picks to send drafts to.

## Consequences

- Mercator, Cloudflare's API and the Goblin Wallet are ordinary servers, added from the shelf or by URL; their tools
  start ungranted like any other's.
- The owner API loses `POST /api/mcp/:id/recommended`, `GET /api/mcp/:id/status`, the spending and top-up endpoints and
  `ApprovalDecision.runUpTo`; `ServerView` loses `profile`. Connections lists connections in the order they came, those
  to one server side by side, and an empty chat no longer offers to connect a server.
- The tables `app_mcp_spend_rules` and `app_mcp_spend` stay in the migrations, unread, until a later squash. The flow
  `top_up` leaves telemetry.
- `ToolView.needsInput` says that a tool's input schema requires an argument; the smoke's MCP probe is any granted tool
  that runs without asking, says it only reads and needs no input.
- A server that needs a vendor's wording to be useful gets it from its own descriptions and skills, read as data.

## Rejected

- **Keeping profiles as data** (a deployment's list of servers with goblin's words and recommended grants): suggested
  access and the shelf already carry what is left, and a second place for a server's words would drift from the
  server's own.
- **A spending rule for any tool, from an argument the owner names**: which argument is money, and in what unit, is a
  claim goblin cannot check; Ask first and the server's own limits stay the controls.
</content>
</invoke>
