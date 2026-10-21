# ADR 0093: Members, invitations and roles

Status: Accepted 2026-10-21 with the owner, as the first part of multiplayer after ADR 0089 (workspaces own agents).
Takes the place of the withdrawn ADR 0014's members. Messages attributed to their member, answers by whoever asked
and private channels follow in their own ADRs, in that order.

## Context

ADR 0089 gave every agent to a workspace, with people as its members, and every workspace had one member: its owner.
ADR 0014 had let other people into one person's agent, where that person's connections and main conversation were
the authority every member acted with, and it was withdrawn. A workspace has no such person: its connections are the
workspace's own.

## Decision

**Authority belongs to the workspace; a role decides who changes it.** Every member works with the workspace's agent,
its connections and grants, as its owner always has. An endpoint that changes what the agent may do needs an admin
(`EndpointRole: 'admin'` in the contract, checked by owner admission, an owner counting as one; else `Forbidden`,
`role`): connecting, renaming and removing servers and registries, grants, Ask first, skills, App grants, dismissing
Event offers; confirming, routing, pausing and removing Sources, and Notify me via; the model and the model endpoint;
resident authority; routine settings and confirming a routine; changing and deleting an agent app; Start. Everything
else a member may do, in every channel: there are no private channels yet. An OAuth client acting for a member gets
no more than the member. A server's key, the workspace's, reaches what its scopes reach, as before.

**Who governs whom.** Owners and admins invite, change roles and remove; an admin governs members only, an owner
everyone, and only an owner invites an admin or makes an owner. A workspace always keeps one owner: the last one is
never demoted, removed or let go. Anyone else may leave.

**An invitation is for one address, for seven days.** Its ID, 128 random bits, is its link (`/invite/<id>`); the
link shows, with or without a session, the workspace, who invited, the address and the role, and joining needs a
session of that address. Inviting an address that is already a member is refused; inviting one already invited
replaces the old invitation. goblin's own mailer sends it, and an invitation whose mail did not go out says so
(`mailed: false`) so its link can be shared by hand. Taking one is one D1 batch that adds the membership only while
the invitation waits; joining twice makes no second membership.

**An invitation lets its address in.** An address with an invitation waiting may sign up by emailed code whatever the
sign-up mode. A sign-in through the deployment's provider still follows the mode, since its address is not known when
it starts. A person who has no workspace and an invitation waiting is not given one of their own: home shows the
invitations and offers to start their own instead.

**Removing a member ends their reach at once**: their membership, and the OAuth consents and refresh tokens they gave
clients for the workspace. Their next request finds no membership, since every request reads it.

The records are the organization() plugin's tables, read and written by the Worker's account APIs
(`auth/members.ts`): a workspace's members and invitations under `/w/<slug>/api/members…`, a person's invitations at
`/api/invitations…`.

## Consequences

- Several people can work in one workspace's channels with one agent. Until messages carry their member, every
  member's message looks like one's own in the chat, and to the agent like the owner's.
- An Ask-first prompt, a Persona's hold or a routine question can be answered by any member for now.
- An event stream already open when its member is removed stays open until it reconnects.
- Settings shows a member only what is theirs to change; a refused admin action elsewhere says it is not allowed.

## Rejected

- **Members acting with their own authority inside the workspace** (ADR 0014's design): the workspace's connections
  are the authority, and a role decides who changes them.
- **The plugin's own invitation endpoints**: its invitation mail swallows a failed send, and its acceptance reads the
  session's active organization, which goblin does not use for browsing (ADR 0089).
- **Links anyone may join with**: a forwarded link would admit whoever holds it.
