# ADR 0117: The setup extra reaches a workspace's connections

Status: Accepted 2026-10-24 (owner, with the approved plan to move every integration onto a credential). Amends ADR
0098 (its "connections and grants stay off `/mcp`") and ADR 0114 (what the `setup` extra holds).

## Context

ADR 0098 opened setups and routines to a client and kept connections and grants off `/mcp`: adding an MCP server,
starting its sign-in, granting its tools and turning on its skills took an admin's session in the web. ADR 0114 turned
those switches into a grant's level and extras, and `/mcp`'s instructions came to say that `setup` covers "setups,
Sources and servers", while the endpoints themselves still took no credential. A coding agent that sets up a
workspace for a product (agent-jobs for Sidequest) therefore drove goblin through a person's session cookie, the one
thing goblin's credentials exist to replace.

## Decision

**A credential's `setup` extra reaches the workspace's connections themselves.** With `read` it lists them and their
tool grants; with `manage` it also adds a server, renames one, starts its sign-in, disconnects and removes it, sets its
tool grants (one or a batch) and its skills switch. Each endpoint keeps `EndpointRole` admin and gains `EndpointAccess`:

| Endpoint | Needs |
| --- | --- |
| `GET /mcp/servers`, `GET /mcp/grants` | `read` and `setup` |
| `POST /mcp/servers`, `PATCH /mcp/:id`, `POST /mcp/:id/remove` | `manage` and `setup` |
| `POST /mcp/:id/connect`, `POST /mcp/:id/disconnect` | `manage` and `setup` |
| `PUT /mcp/grants`, `PUT /mcp/grants/batch`, `PUT /mcp/skills` | `manage` and `setup` |

So owner admission holds a credential to its grant as everywhere (ADR 0114), and an OAuth client to its person's role
too: a member's client is refused (`Forbidden` `role`) whatever its grant, an admin's or an owner's with `manage` and
`setup` succeeds, and a server's key with them succeeds in its own workspace. Each handler checks the connection it
touches is within the credential's reach (`AccessInsufficient` naming it), a connection a credential adds is within
its reach from then on (listed when its connections are a list), and the server and grant lists show only what it
reaches. `/mcp` gains a tool for each: `server_add`, `server_rename`, `server_connect`, `server_disconnect`,
`server_remove`, `tool_grants_list`, `tool_grant_set`, `tool_grants_set` and `server_skills_set`.

**Starting a sign-in is not finishing it.** `server_connect` answers the server's authorization URL; the sign-in comes
back to goblin's callback, which admits a member's browser session of the workspace its `state` names (ADR 0089). So
a credential can prepare a connection, and a person finishes it where they are signed in.

**Still a person's:**
- calling a server's tool by hand (`POST /mcp/:id/tools/call`) and reading its resources, outside any turn;
- an MCP App's grants (`PUT /mcp/app-grants`) and the ask-first switches, which decide what waits for a person;
- confirming, confirming again and running a routine, a person's deliberate approval (ADR 0098);
- the registries, step-up, held calls and URL requests;
- the agent's model and model endpoint, and a person's own conversations (`POST /conversations`).

## Consequences

- agent-jobs sets up Sidequest's workspaces with Claude Code's goblin `/mcp` as a delegate of Kris or Aurora, and the
  Sidequest team account's cookie goes.
- A key that holds `setup` can now change its workspace's connections; keys go in favour of installed apps (the plan's
  phase 6), whose grant an admin approves the same way.

## Rejected

- **A credential finishing a sign-in.** The callback would have to trust a code with no person behind it; the owner of
  the remote account signs in with their own browser.
- **Opening `tools/call` with `setup`.** A direct call is a turn's power outside a turn: no sender, no Topic, no
  receipt. A credential that wants a tool's effect sends a message.
