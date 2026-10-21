# ADR 0094: A member's message names who wrote it

Status: Accepted 2026-10-21 with the owner, as the second part of multiplayer after ADR 0093 (members, invitations and
roles). Amends ADR 0086: an OAuth client's messages in a workspace of several people name the member it acts for.
Answers by whoever asked and private channels follow in their own ADRs.

## Context

ADR 0093 let several people work in one workspace's channels with one agent. A message from the web carried no author,
so the agent read every member's words as the owner's, and each person's chat drew everyone's messages as their own.
Messages from elsewhere already carried a leading author block (`[from Claude Code]`, the `authorTag` contract, ADR
0086), which the agent is told about and the web draws by name.

## Decision

**In a workspace of several people, every member's message starts with who wrote it**: a `[from member <name> · <user
ID>]` block (`memberAuthor`), written by goblin in front of the words, never taken from them. The name is the person's,
or their address's local part, cut to 50 characters with `]`, `·` and line breaks taken out; the ID makes two people of
the same name two authors. A workspace of one person marks nothing, as before.

**The Worker says whether the workspace is shared.** It reads the membership with the workspace's member count on every
request already, and forwards the member's name and whether others are in the workspace with their user ID and role
(`x-goblin-member`, `{user, role, name, shared}`). The agent decides the block from that alone: the count is current, so
a message after someone joins is marked, and one after the last other person leaves is not.

**An OAuth client acting for a member in such a workspace names both**: `[from <client> for <name>]`. A key's message
is unchanged: it is the workspace's.

**The agent is told who speaks.** The persona says that each person in a shared workspace writes in the web app with a
`[from member …]` line, and to answer the person who asked. Its trust rules count a member's messages as instructions
with the owner's; a member's authority is the workspace's, within their role (ADR 0093).

**Each person sees the others by name.** The web reads the block (`memberOf`): a message by another member shows on the
other side, in a muted bubble, under their name; one's own messages look as they always have. A sent message waits for
its echo by its sender's user ID, so another member's message arriving first never ends it.

## Consequences

- Messages from before a workspace had a second person carry no name: every member's chat draws them as their own.
- A member can still answer an Ask-first prompt, a Persona's hold or a routine question that someone else's turn
  raised: answers by whoever asked follow in their own ADR.
- The agent sees the user ID of whoever writes, which is no secret inside the workspace: Settings lists its people.
- A key's message still carries no author, so in the threads a key made its words could open with a member's block
  and pass for theirs. A key is the workspace's own server, made by its admins, and gains no authority by it; naming a
  key's messages in a shared workspace needs its name forwarded with it, and is left for later.

## Rejected

- **Marking every message, alone or not**: a workspace of one would pay the block on every turn for nothing, and its
  history would read differently from every workspace that existed before multiplayer.
- **A name with no ID**: two people of the same name would be one author to the agent and to the web.
- **Authorship in Pi's message metadata instead of its content**: the model reads content only, and Pi owns its
  message shape.
