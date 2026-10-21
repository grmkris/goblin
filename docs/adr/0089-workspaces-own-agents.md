# ADR 0089: Workspaces own agents

Status: Accepted 2026-10-21 with the owner. Supersedes ADR 0004's routing (each account owns one agent named by its user
ID, chosen from the user) and the root rule that a user only ever reaches their own agent. Amends ADR 0081 (a key
belongs to a workspace), ADR 0086 (an OAuth client's consent names a workspace) and ADR 0087 (the owner's
subscription models belong to one workspace). Members, private channels and shared Telegram follow in their own ADRs.

## Context

Every account owned exactly one agent, named by its user ID. A second agent for a separate purpose (a product whose
customers run through keys, a project with its own connections) needed a second account, with an email address made up
for it and a saved session, and one person could not hold several under one sign-in. Nor could people share an agent:
ADR 0014 put members inside one person's agent, whose connections and main conversation were that person's, and was
withdrawn.

Everything that carries authority already lives in the agent: connections, credentials, grants, resident authority,
budget, model endpoint, files, what keys reach and what cross-Topic search sees. A Topic focuses work and isolates
nothing (ADRs 0040, 0081). The unit to give people is therefore the agent itself, not a part of one.

## Decision

**A workspace owns the agent.** A workspace is an organization of Better Auth's `organization()` plugin in the auth D1;
its one agent is the `PersonalAgent` object named by the workspace's ID. A person is a Better Auth user with
memberships, each with a role (`owner`, `admin` or `member`). Everything the agent holds is the workspace's.

**Every person has a workspace.** A signed-in person with no membership is given one (named after them, which they can
rename in its Settings) before anything else answers. More are made from the workspace menu, each starting with
Start. A workspace has a name and a slug: 3 to 40 lowercase letters, digits and inner hyphens, unique, and changeable
by its owner, which breaks links that used the old one.

**The credential decides the workspace; a browser names it in the path.**

- A browser session is a person's, and a person may belong to several workspaces. Its pages and API calls are under
  `/w/<slug>/` (`/w/<slug>/api/…`, its two event streams included, which is why the workspace cannot travel in a
  header: `EventSource` sends none), so a page's own address says which workspace its calls are for. The Worker
  reaches the agent only after one D1 read finds that person a member of that slug's workspace, and forwards the
  request to the agent's unchanged `/api/…` with the member (`x-goblin-member`: the user's ID and role).
- A server API key belongs to one workspace (the key plugin's `references: 'organization'`; who made it is in its
  metadata) and reaches that workspace at `/api/…` and `/mcp`, as before.
- An OAuth client's consent names one workspace: the consent page asks which when the person has more than one, and
  the consent is stored for it (`consentReferenceId`). Its token reaches that workspace at `/mcp`, and only while the
  person is still a member.
- Events hooks and file links already carry a signed agent name; it is the workspace's ID.

Nothing in a request names an agent: a slug reaches one only through the person's membership, a key or a token only
its own workspace. A session on `/api/…` or a key on `/w/…` names no route.

**The plugin keeps the records; goblin serves them.** The plugin's own HTTP routes are not served (as the key plugin's
are not). The Worker's typed account APIs read and write its tables: a person's workspaces (`/api/workspaces`, to list,
make, rename, move and delete them), and a workspace's own records (`/w/<slug>/api/keys` and `/w/<slug>/api/clients`,
the OAuth clients the member connected to it). A change that spans rows is one D1 batch, which D1 runs as a
transaction, and a unique index on a membership's workspace and person makes a second membership impossible rather
than unlikely.

**A forward says who acts.** A request the Worker forwards carries a member (a session), a caller (a key), or a caller
and the member it acts for (an OAuth client). One that carries none of these, or one that does not decode, is refused;
it is never taken for the owner. A member's presence grants resident authority as the owner's did (ADR 0088); a
caller's never does.

**Existing accounts keep their agents.** An additive auth migration gives each existing user a workspace whose ID is
their user ID, its slug from their email address, with them as its owner, and moves their keys to it. The agent's
name, its R2 prefix, its Events hook tokens and the sealed model endpoint's binding all use that ID, so no agent data
moves. New workspaces get new IDs.

**The owner's subscription models belong to one workspace** (`GOBLIN_OWNER_WORKSPACE_ID`, formerly the owner's user ID,
with the same value). ADR 0087's fence stays: never in a key's work.

**Deleting.** An owner deletes a workspace by typing its name: its agent is erased first (ADR 0004's order), then its
keys, invitations, consents and memberships. Deleting an account deletes the workspaces it alone owns and ends its
other memberships.

## Consequences

- One sign-in holds any number of workspaces. A product's runtime is a workspace used only through its keys; nobody
  needs an address made up to sign in as it.
- Every page and browser API path changes; links without a workspace no longer resolve (goblin is greenfield). Keys,
  MCP clients, hooks and file links keep their paths.
- Per-agent things are per workspace: the budget and its cap, the model endpoint, resident authority, telemetry's
  agent hash (unchanged for an existing account, whose workspace keeps its ID).
- Roles are stored now and every member of a workspace is its owner until members can be invited; enforcing roles per
  endpoint, invitations and attributing each message to its member come with them.
- The agent's class keeps the name `PersonalAgent` until a production reset renames it, since renaming a Durable
  Object class is a storage migration.

## Rejected

- **A workspace as a group of Topics in one agent**: connections, grants, budget and search are agent-wide, so it would
  isolate nothing.
- **The session's active workspace** (the plugin's `activeOrganizationId`): one choice for every tab of a browser, and
  no link that names the workspace it belongs to.
- **The workspace in every path, for keys and `/mcp` too**: a key or a consent already names its workspace, and one
  `/mcp` resource keeps clients' sign-in standard.
- **Goblin's own membership tables** (ADR 0014): the plugin is Better Auth's own, and the key plugin's organization
  keys depend on its membership.
