# ADR 0118: A product installs into a workspace

Status: Accepted 2026-10-24 (owner, with the credentials plan). Amends ADRs 0081 (what a server uses to reach goblin),
0086 and 0116 (who an OAuth token may be), 0089 (how a request reaches a workspace's agent), 0112 (who holds Events
leases) and 0114 (the kinds of grant).

## Context

A product that builds on goblin (Swarmm, or anyone's like it) reached it with a server API key: an owner made the key
in Settings and pasted its secret into the product's own secrets. Nothing let a product say who it is, ask for what it
needs, or be connected by a workspace's own admin from the product itself. A key also stood for two things at once: a
script's credential and a product's. OAuth clients act only for a person (ADR 0114): their grant is capped by that
person's role and ends with their membership, which is wrong for a product that must keep working when the admin who
connected it leaves.

## Decision

**An app is a confidential OAuth client a workspace registers.** An owner or admin registers it under Settings →
Developer (`POST /w/<slug>/api/developer/apps`): a name, a homepage, the addresses an install may send people back
to, and the grant terms it asks for. goblin makes the client server-side through Better Auth's admin registration
(`adminCreateOAuthClient`, server-only), with the `client_credentials` grant, `client_secret_basic` and goblin's one
scope, and gives it to the workspace. Its `oauthClient` row names no person, so it outlives the one who registered
it. The secret is shown once; goblin rotates it itself (`POST …/developer/apps/:clientId/rotate`) by writing the hash
the token endpoint checks: Better Auth's default SHA-256, configured explicitly (`storeClientSecret`) so stored
secrets keep verifying. Better Auth's own client endpoints (`/oauth2/create-client`, `update-`, `delete-`, `get-`,
`rotate-secret`, `/admin/*`) are not served: apps are registered, changed and ended only through goblin's account API,
and `clientPrivileges` allows the scope configuration that registration needs. No `oauthProvider()`, no adapter.

**An installation is the app in one workspace, with a grant.** A workspace's owner or admin installs it from the
install page (`/install/<clientId>`, `GET|POST /api/install/:clientId`): they choose one of the workspaces they own or
administer, read "acts as <app>, not as you", and approve the grant editor's terms, prefilled with what the app asks
for and capped by their role. The installation's grant is a `grant` of the new kind `app` whose id is the
installation's (as a key's is the key's), reaching that workspace only; any of the workspace's owners and admins
changes it (Settings → Installed apps, `PATCH /w/<slug>/api/installations/:id`, and the widening page) or uninstalls it
(`DELETE …/installations/:id`). It outlives the person who approved it. Approving answers the app's registered return
address with `installation`, `workspace` (the slug) and `state`; the app confirms the installation with its own token,
never by trusting that redirect. A script app is registered with no return address and installed in its own workspace
in the same step: the credential for a script or CI job.

**An app's token is its own.** Its backend asks the token endpoint (`POST /api/auth/oauth2/token`,
`grant_type=client_credentials`, HTTP Basic client authentication, `resource=<origin>/mcp`, `scope=goblin`) for an
access token: a JWS whose subject is the client itself, an hour long. `verifyAccessToken` tells it from a person's
client by that subject, and admits it if the client is an app. The token names no workspace: a request names one in
its path (`/w/<slug>/api/…`, ADR 0116) or, on `/mcp`, in its `workspace` argument, among the workspaces where the app
is installed now, else `NotFound` `workspace`. One token serves every installation; each request goes as that
installation's credential (kind `app`), with no member: an app acts for no one. Owner admission holds it to its grant as
it does a key's, and a turn it starts is a server's (ADR 0115): labelled with the app's name, on the deployment's
models, its power the grant's. Its Events leases are held by its installation (`app:<installation id>`) and end before
an uninstall, a deleted app or a narrowing of its Topics.

**ADR 0089's rule** gains a way in: a request reaches an agent through its key's workspace, a workspace an OAuth
client's call names among those its reach covers, an app's installation in the workspace its call names, or a
session's slug, each checked live.

## Migration

`0006_apps.sql` widens `grant`'s check to the kind `app` (the three grant tables copied aside, dropped children first,
made again and refilled: no row changes) and adds `app` (an app by its client, its workspace, the terms it asks for,
whether it is a script app) and `installation` (an app in a workspace, its id its grant's, once per pair). Deleting a
workspace deletes the installations in it and the apps it registered with all their installations.

## Consequences

- A product connects to goblin with a "Connect goblin" button: no secret is copied by hand, and the product appears
  under the workspace's Installed apps with its grant.
- The same registration works for anyone: a third party registers its app in its own workspace, and each workspace that
  wants it installs it there, on that workspace's models and grant.
- Keys remain until nothing uses them; a script app does what a key did, and the key path goes in a later release.
- A token from before an uninstall keeps verifying for up to an hour, but reaches nothing: every request reads the
  installations live.

## Rejected

- **An installation as a person's OAuth client.** Its grant would be capped by, and end with, the person who approved
  it; a product is the workspace's.
- **Copying Better Auth's client endpoints for app management.** They tie a client to the person who made it; goblin's
  account API ties it to a workspace and checks the role itself.
- **A token per installation** (the workspace in the token request). One token per app is the standard client
  credentials shape; the path names the workspace exactly as it does for a person's client.
