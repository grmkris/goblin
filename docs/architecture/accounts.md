# Accounts

## Accounts

There are two ways in ([ADR 0064](../adr/0064-openid-connect-and-config-driven-deployment.md)): an emailed code when
the deployment can send mail, and the deployment's OpenID Connect provider when one is configured. `/health` lists the
ones it offers (`signIn`), and the sign-in page shows the provider's button first, then the email form. A deployment
needs at least one: Alchemy refuses a deploy with neither. Password, reset, verification-link and passkey endpoints
are unavailable.

**Emailed codes.** A six-digit code expires after 600 seconds, permits five attempts and is stored hashed in Better
Auth's verification table. Sending is limited to one code per address per minute and ten sends per IP per hour;
sign-in permits twenty attempts per IP per five minutes. D1 holds rate limits because auth is created per request. A
successful code creates an email-verified account or signs its owner in. Mail uses Cloudflare Email Sending
(`GOBLIN_MAIL_SENDER`; goblin's own stages send from `hello@goblin.surf`); local workerd captures `.eml` files through
Alchemy's simulator. Better Auth 1.7.6 swallows mail callback errors, so a request-scoped delivery flag and after hook
erase an undelivered code and return 503. No account or session is created by sending a code.

**The deployment's provider** (`auth/oidc.ts`). `GOBLIN_OIDC_ISSUER`, `GOBLIN_OIDC_CLIENT_ID` and
`GOBLIN_OIDC_CLIENT_SECRET` (a secret binding) together turn on Better Auth's `genericOAuth` plugin with one provider,
`oidc`, labelled `GOBLIN_OIDC_LABEL` ("Sign in with mysi"; unset, "Sign in with" the issuer's host). It discovers the
provider at `<issuer>/.well-known/openid-configuration` and needs its signing keys there (every ID token is verified
and bound to the sign-in's nonce), sends PKCE, and asks for `openid email profile`. A generic provider is one of Better
Auth's social providers, so it uses the core routes `/api/auth/sign-in/social` and `/api/auth/callback/oidc`, the
redirect URI the provider must allow; nothing it adds sits under the MCP provider's `/oauth2/*`. Building it reads the
discovery document, so `handleAuth` builds it only for those two routes (`AuthNeeds.provider`); everything else,
`getSession` included, builds Better Auth without it. The sign-in may not bring its own ID token or scopes, and
twenty start per IP per five minutes. goblin keeps none of the provider's tokens (an account row is written without
them and never refreshed), signing out leaves the provider's session alone, and linking or unlinking a provider by
hand and the token endpoints answer 404.

**Sign-up.** `GOBLIN_SIGNUP_MODE=open` admits new accounts; `invite` requires `GOBLIN_SIGNUP_INVITE_CODE` in the
`x-invite-code` header (on a code's send and verify, or when a provider's sign-in starts); `closed` permits only
existing accounts. For a provider's sign-in the Worker decides when it starts, over whatever the browser asked, and
Better Auth keeps the answer in the sign-in's stored state (`disableImplicitSignUp` with `requestSignUp`); a refused one
comes back to `/login?error=signup_disabled`. A provider's account is created only for an email the provider says is
verified (`validateUserInfo`, else `email_not_verified`), and it joins an existing account with the same email only when
the provider says the email is verified and the account's own is verified too (else `account_not_linked`); no provider
is trusted past that. So whoever signs in by code and by the provider with the same verified email reaches one
account. The sign-up mode decides who may make an account, and an invitation waiting for an address lets it in
whatever the mode (ADR 0093); every signed-in person reaches the workspaces they are a member of, each agent and
everything in it, within their role ([ADR 0058](../adr/0058-no-plans-tokens-and-an-optional-cap.md)).

### Workspaces

A workspace owns one agent, the `PersonalAgent` object named by its ID ([ADR
0089](../adr/0089-workspaces-own-agents.md)). Its records are Better Auth's `organization()` plugin tables in the auth
D1 (`organization`, `member`, `invitation`; `auth/workspaces.ts` reads and writes them, the plugin's own routes are not
served); a unique index keeps one membership per person and workspace. `GET /api/workspaces` lists the person's, oldest
membership first, and gives a person with none a first one (named after them, its slug from their address) in one D1
batch that runs only while they still have none. `POST /api/workspaces` makes another, `PATCH` renames it or moves its
slug (an owner or admin), `DELETE` deletes it (an owner): its agent is erased first, then its keys and their grants,
its place in clients' grants and its memberships.

Which agent a request reaches comes from its credential: a browser session names the workspace's slug in its path
(`/w/<slug>/api/…`), checked against the person's membership in one D1 read on every request; an API key belongs to
one workspace; an OAuth client reaches the workspaces its grant names ([ADRs
0097](../adr/0097-one-mcp-reaches-the-workspaces-its-consent-chooses.md), [0114](../adr/0114-one-grant-for-every-credential.md)),
read with the person's memberships on every call, and each call names the one it is for: in its `/mcp` arguments, or
in its path (`/w/<slug>/api/…`, [ADR 0116](../adr/0116-an-oauth-client-uses-the-owner-api-too.md)). A person's clients are
theirs, at `/api/clients` (`auth/clients.ts`).

### Grants

Every credential has one grant ([ADR 0114](../adr/0114-one-grant-for-every-credential.md),
`packages/contracts/src/grants.ts`), in goblin's own auth D1 tables beside Better Auth's (`auth/grants.ts`): `grant`
(its level, extras, lifetime and end, whether it reaches all of its person's workspaces, the MCP origins its threads
may bring, revoked or not), `grantWorkspace` (per workspace, Topics, Personas and connections each `all` or `list`,
and a generation that only moves on) and `grantReach` (the listed ids). A key's grant has the key's id and reaches its
one workspace; a client's has its own id (`cg_…`), one per client and person. A change bumps the generation of every
workspace it names, and a credential's create appends what it made to a list it has (`appendReach`).

Approving is the person's who may: a key's grant an owner or admin of its workspace, a client's its own person; only
an owner gives `keys`. A grant they may not approve is not found. `GET /api/grants/:id/terms` and `PUT /api/grants/:id`
serve the widening page a refusal links to (`/consent/widen?grant=…`); `GET /api/clients/:clientId/terms` and
`PUT /api/clients/:clientId/grant` the consent page (before the consent) and Settings (`auth/consent-terms.ts`). A change
that narrows a grant's Topics ends its holder's published Events leases there first.

### Members and invitations

A workspace's people ([ADR 0093](../adr/0093-members-invitations-and-roles.md)) are its `member` rows, each with a role;
`auth/members.ts` reads and writes them. `GET /w/<slug>/api/members` lists them for any member; owners change roles
(`PATCH …/members/:userId`), owners and admins remove (`DELETE`), an admin only members and an owner anyone, and the
last owner stays, as it does when its account is deleted (refused while others work in the workspace); anyone else may
leave (`POST …/members/leave`). Removing someone, or their leaving, takes the workspace out of their MCP clients'
grants in the same batch (ADRs 0097, 0114).

`POST /w/<slug>/api/members/invitations` invites addresses with a role (only an owner invites an admin): one
`invitation` row each for seven days, replacing one still waiting for that address, mailed from the deployment's sender
with the link `/invite/<id>`; the answer says per address whether its mail went out. The deployment owner's own
workspace refuses invitations while it is offered their subscription models (`offersOwnerModels`, `Conflict`
`owner_models`, [ADR 0095](../adr/0095-the-owners-subscription-workspace-takes-no-members.md)). A person's invitations are
`/api/invitations`: `GET` lists those waiting for their address, `GET /api/invitations/:id` previews one with or
without a session (the link is all a visitor has), and `accept` or `decline` needs a session of the address it is for.
They are the person's, not a workspace's, so the web shows the same ones in every workspace: a moss count on the
workspace menu, which lists them first with Join and No thanks answered in place, and Activity's Needs you (they count
in Activity's number). Joining opens the workspace joined; a refusal says why in the person's words (`owner_models`, an
expired or withdrawn one). The menu also names the person's role in each workspace, and its tooltip the role here.
The email-code gate (`auth/email-code.ts`) lets an address with an invitation waiting sign up whatever the sign-up
mode, and `workspacesOf` gives such a person no first workspace of their own.

The membership read counts the workspace's people too, and the Worker forwards the member to the agent as
`x-goblin-member` (`{user, role, name, shared}`, `http/api/principal.ts`): `shared` while anyone else is a member, so
each of their messages then names who wrote it ([ADR 0094](../adr/0094-a-members-message-names-who-wrote-it.md)).

The browser's OAuth provider client carries an MCP client's authorization query through either sign-in to consent: a
provider's sign-in keeps it in the sign-in's state and the callback goes on to the authorization.

The MCP Events hook and file links verify a token bound to the agent (the workspace's ID) before selecting it. Deleting
an account requires a sign-in from the last 600 seconds, with an explicit Settings confirmation. It first deletes every
workspace the account alone owns, each agent erased through `Agent.destroy()` (Pi, Agents and application tables, its
alarm and isolate), its files in R2 first, before its records. Only then does Better Auth delete the user and D1 cascade sessions, other
memberships, consents and tokens. Agent-erasure failure leaves the account intact for retry. Outbound OAuth tokens are
forgotten, not revoked remotely. Conversations, credentials, grants and resident authority belong to one workspace.

### A public landing at `/`

Home (`routes/index.tsx`) decides before anything is drawn. On the server, a request carrying Better Auth's session
cookie (`__Secure-better-auth.session_token`, or `better-auth.session_token` on the local stack; `lib/home.ts`) gets a
307 to Personal's channel, `/c/1`; in the browser the session the cache already holds decides, without waiting on the
network, and the landing leaves for the tab's last channel if a check under way says signed in. The cookie is only a
hint: `OwnerGate` still decides on every owner page. Everyone else gets goblin's landing (`components/landing`), which
the root draws as a page of its own (`main.landing-root`: no shell, no splash) with Safari's bars tinted moss. The
sidebar's goblin mark links to `/`, which the cached session turns into the owner's channel; signing in, signing out and
deleting the account `assign('/')`, so the server's cookie check sends each to their chat or to the landing.

The landing is built from `@goblin/ui`'s marketing parts (`src/marketing`: `SiteBar`, `MossFrame`, `Section`,
`SiteFooter`). Its hero plays one scripted session in goblin's panel (`hero-session.tsx`): the entrances are CSS, timed
from the first paint, and the script follows the same animation clock for the presence orb and owns the answer to its
question, which the visitor may give or which gives itself after about six seconds in view; under reduced motion it
starts at the question. Claude Code's command names the page's own origin. The Source link waits behind a constant
until the public repository is public. The head carries Open Graph and Twitter tags with `public/og.png`
(`bun run icons`) and the canonical URL, both on the deployment's own origin (`lib/origin.ts`: `APP_URL`, which the
canonical redirect makes every page request's origin, ADR 0064), and the web Worker serves `/robots.txt` by stage:
production allows everything but `/api/` and `/mcp`, other stages nothing. `Meet your goblin` opens `/login?new=1`,
`Authentication` in create mode where sign-up is open or by invite.

### First-run Start

ADRs 0062, 0079 and [0080](../adr/0080-server-owned-start-kickoff.md). A short, goal-first setup flow the owner may
pass by or skip; no page waits for it, whatever its status, so the app is drawn the same for an open, skipped or finished
Start. An owner who signs in through Create an account (`routes/login.tsx`) lands on `/start/welcome`.

**The page** (`components/start`). `/start/<step>` fills the screen (`routes/__root.tsx` draws no shell around it): one
task per screen beside a panel in the sidebar's own green, which on a phone narrows to a band with a count and one
segment per step:
1. welcome: the owner's goal. Each example (`start/steps.tsx` `IDEAS`) fills the goal, names the channel and picks
   the service groups the shelf shows first; a goal of the owner's own keeps the defaults;
2. model: the deployment's models unless the owner brings their own endpoint and key, in Settings' own form
   (`model-endpoint-card.tsx` `ModelEndpoint`);
3. services: the shelf (`server-add.tsx` `SuggestedServers`, previewing those groups); the server just connected
   from here, by a sign-in that came back or one that needed none, offers Use suggested access
   (`start/connect-server.tsx`);
4. review the channel name and first message. `POST /api/onboarding/kickoff` does the rest in one call
   (`onboarding/program.ts` `kickoff`): it creates the channel with the goal as its description, records the kickoff
   into it, sends the goal as the owner's first message and marks Start done, each under an operation id made from the
   kickoff's, so a retry replays it. A submitted or settled chat operation receipt skips message admission on retry,
   even if the channel or budget has since changed. Only typed pre-creation failures (`topic_name_taken`, `topic_name`
   or `empty_message`) reopen the draft; later admission failures and unknown outcomes keep it frozen for a retry.
   The tab retains the draft across model setup and OAuth returns and clears it on finish or sign-out.

Continue marks the step gone through; Skip setup skips Start. Finishing narrows the panel into the sidebar as the chat
appears.

**State** (`onboarding/`). `app_onboarding` keeps the status the owner set (`done`, `skipped`; `open` otherwise, and
again after they reopen it), the steps they went through and the kickoff: its time and logical channel id, both or
neither. `GET /api/onboarding` answers from the agent alone: a step is done once the owner went through it, the model step also once they set their own endpoint
(`Inference.view`), the goblin step once the kickoff was sent. It also carries the endpoint in use and how many servers
are connected. A step id an older Start had is dropped when the row is read.

**Sign-ins.** `POST /api/onboarding/connect` notes the step against the connection (`app_onboarding_connects`, an
hour). The OAuth callback (`mcp/servers/program.ts` `connectCallback`) takes the note and redirects to `/start/<step>` rather
than Connections. Nothing is allowed on the way.

**Ways back** (`start/setup-cards.tsx`). While Start is not finished and the model or services step is left, the chat
shows one quiet line back to the first step still to do, which the owner can put away for the visit. Settings has a
Set up goblin card and Activity a Get started checklist.

**In the chat.** For twenty minutes after kickoff, `pi/onboarding.ts` asks the selected channel to begin useful work,
ask a focused question only if necessary, and introduce Personas or routines when the work calls for them. The logical
channel resolves to its current Pi session; unrelated chats receive no kickoff guidance.
