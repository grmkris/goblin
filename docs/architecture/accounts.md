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
account. The sign-up mode is the only access control: every signed-in account reaches its own agent and everything in
it ([ADR 0058](../adr/0058-no-plans-tokens-and-an-optional-cap.md)).

The browser's OAuth provider client carries an MCP client's authorization query through either sign-in to consent: a
provider's sign-in keeps it in the sign-in's state and the callback goes on to the authorization.

The agent a request reaches derives from the session's user ID or the inbound token's subject. The Telegram hook
verifies a token bound to its user ID before selecting an agent. Deleting an account requires a sign-in from the last
600 seconds, with an explicit Settings confirmation. It first erases the user's agent through `Agent.destroy()`:
Pi, Agents and application tables, its alarm and isolate. Only then does Better Auth delete the user and D1 cascade
sessions, consents and tokens. Agent-erasure failure leaves the account intact for retry. Outbound OAuth tokens are
forgotten, not revoked remotely. Conversations, credentials, grants and resident authority belong to one user.

### A public landing at `/`

Home (`routes/index.tsx`) decides before anything is drawn. On the server, a request carrying Better Auth's session
cookie (`__Secure-better-auth.session_token`, or `better-auth.session_token` on the local stack; `lib/home.ts`) gets a
307 to Personal's channel, `/c/1`; in the browser the session the cache already holds decides, without waiting on the
network, and the landing leaves for the tab's last channel if a check under way says signed in. The cookie is only a
hint: `OwnerGate` still decides on every owner page. Everyone else gets goblin's landing (`components/landing`), which
the root draws as a page of its own (`main.landing-root`: no shell, no splash) with Safari's bars tinted moss. The
rail's Home and mark link to `/`, which the cached session turns into the owner's channel; signing in, signing out and
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

ADR 0062. A short tour the owner may pass by or skip; no page waits for it, whatever its status, so the app is drawn
the same for an open, skipped or finished Start. An owner who signs in through Create an account (`routes/login.tsx`)
lands on `/start/welcome`.

**The page** (`components/start`). `/start/<step>` fills the screen (`routes/__root.tsx` draws no shell around it): one
task per screen beside a panel in the rail's own green, which on a phone narrows to a band with a count and one
segment per step:
1. welcome: what goblin is (goblin, the model it thinks with, the services it reaches);
2. model: the deployment's models unless the owner brings their own endpoint and key, in Settings' own form
   (`model-endpoint-card.tsx` `ModelEndpoint`);
3. services: the shelf (`server-add.tsx` `SuggestedServers`); the server just connected from here, by a sign-in that
   came back or one that needed none, offers Use suggested access (`start/connect-server.tsx`);
4. what the owner wants goblin for. The kickoff is recorded before its message is sent.

Continue marks the step gone through; Skip setup skips Start. Finishing narrows the panel into the rail as the chat
appears.

**State** (`onboarding/`). `app_onboarding` keeps the status the owner set (`done`, `skipped`; `open` otherwise, and
again after they reopen it), the steps they went through and the kickoff's time. `GET /api/onboarding` answers from
the agent alone: a step is done once the owner went through it, the model step also once they set their own endpoint
(`Inference.view`), the goblin step once the kickoff was sent. It also carries the endpoint in use and how many servers
are connected. A step id an older Start had is dropped when the row is read.

**Sign-ins.** `POST /api/onboarding/connect` notes the step against the connection (`app_onboarding_connects`, an
hour). The OAuth callback (`mcp/program.ts` `connectCallback`) takes the note and redirects to `/start/<step>` rather
than Connections. Nothing is allowed on the way.

**Ways back** (`start/setup-cards.tsx`). While Start is not finished and the model or services step is left, the chat
shows one quiet line back to the first step still to do, which the owner can put away for the visit. Settings has a
Set up goblin card and Activity a Get started checklist.

**In the chat.** In main, for twenty minutes after the kickoff, `pi/onboarding.ts` adds the ask to propose Topics and
Personas with one `ask_user` to goblin's context block. Nothing else about setup reaches the model.
