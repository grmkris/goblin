# Accounts

## Accounts

Email OTP is the sole login method. A six-digit code expires after 600 seconds, permits five attempts and is stored
hashed in Better Auth's verification table. Sending is limited to one code per address per minute and ten sends per
IP per hour; sign-in permits twenty attempts per IP per five minutes. D1 holds rate limits because auth is created
per request. `GOBLIN_SIGNUP_MODE=open` admits new addresses; `invite` requires `GOBLIN_SIGNUP_INVITE_CODE` in the
`x-invite-code` header on both send and verify; `closed` permits only existing accounts. A successful OTP creates an
email-verified account or signs its owner in. Password, reset, verification-link and passkey endpoints are unavailable.
The sign-up mode is the only access control: every signed-in account reaches its own agent and everything in it
([ADR 0058](../adr/0058-no-plans-tokens-and-an-optional-cap.md)).

Every stage requires a mail sender. Deployed mail uses Cloudflare Email Sending from `hello@goblin.surf`; local
workerd captures `.eml` files through Alchemy's simulator. Better Auth 1.7.6 swallows mail callback errors, so a
request-scoped delivery flag and after hook erase an undelivered code and return 503. No account or session is created
by sending a code. The browser's OAuth provider client carries the authorization query through OTP login to consent.

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
(`bun run icons`) and the canonical `https://goblin.surf/`, and the web Worker serves `/robots.txt` by stage:
production allows everything but `/api/` and `/mcp`, other stages nothing. `Meet your goblin` opens `/login?new=1`,
`Authentication` in create mode where sign-up is open or by invite.

### First-run Start

ADR 0048. A signed-in owner whose Start is open meets it before the chats, and never sees the app first.

**What gates.** The chat routes and Activity carry `staticData.startRequired`. The root shell (`routes/__root.tsx`,
`onboarding/hooks.ts` `useStartDecision`) reads `GET /api/onboarding/status` as soon as someone is signed in. Until it
knows, a gated page shows goblin's splash (the mark alone, as the Home Screen startup image draws it), not the rail,
the sidebar or the workspace feed; an open Start then goes from the splash to `/start/<step>`, the first step still
to do. The shell follows the shown matches, not the location, so the splash holds while Start loads. Settings and
Connections are never gated, and a state that cannot be read lets the owner in.

**The page** (`components/start`). One task per screen beside a panel in the rail's own green, which on a phone narrows
to a band with a count and one segment per step:
1. welcome: what goblin is (the Goblin Wallet that pays for it, goblin, more to come);
2. the Goblin Wallet: connect it (its recommended tools allowed), then what its own status says is left, with Finish
   setup in your wallet (its `/setup` page, which comes back here), then what it holds, with Add funds in your wallet
   while it holds nothing;
3. services: Mercator first and optional, then the other suggestions;
4. what the owner wants goblin for. The kickoff is recorded before its message is sent.

Finishing narrows the panel into the rail as the chat appears.

**State** (`onboarding/`):
- `app_onboarding` keeps what only the owner can say (finished, skipped, the welcome and services steps, the kickoff),
  and `done` once Start is first found complete. Going through a step never sets the status; `open` there means the
  status is derived. A step id an older Start had is dropped when the row is read.
- Every other step is read live by `GET /api/onboarding` from the connections, the grants (each first-class server's
  status tool, and the wallet's payment tool) and the wallet's own status (`WalletStatus.setup`, `payFrom`).
- The wallet is ready once its status reads, lists no setup and has an address goblin pays from; funded once ready and
  holding anything. Its setup page is built from the
  connection's configured endpoint origin (`mcp/first-class.ts` `walletSetupUrl`), never from what the server says.
- A derived Start is open until the wallet is ready and funded; Mercator is optional. A kept status is answered
  without asking any server.

**Sign-ins.** `POST /api/onboarding/connect` notes the step and whether to allow the server's recommended tools
(`app_onboarding_connects`, an hour). The OAuth callback (`mcp/program.ts` `connectCallback`) takes the note,
allows the tools and redirects to `/start/<step>` rather than Connections.

**In the chat.**
- A skipped Start with something left gets one quiet line back to it. Settings has a Set up goblin card.
- In main, `pi/onboarding.ts` adds to goblin's context block, none of it read from a server: that goblin pays for
  itself from the Goblin Wallet and the wallet's setup page, the pieces not set up yet (Mercator marked optional), and
  for twenty minutes after the kickoff the ask to propose Topics and Personas with one `ask_user`.
