# 0064: OpenID Connect sign-in and config-driven deployment

Accepted 2026-10-15 with the owner. Amends ADR 0001 (identity storage: one more Better Auth plugin), ADR 0002 (stages
and the model plane: the stage is a label, the deployment's model endpoint is optional), ADR 0004 (gated sign-up: the
same gate for a second way in) and ADR 0059 (bring your own model endpoint: a deployment may have none of its own). ADR
0046 governs how goblin's own stages are released and is unchanged. Part of the cleanup that makes goblin an
open-source client anyone can deploy (ADRs 0056 to 0063); the one-click Deploy button comes next.

## Context

A goblin deployment needed things only goblin's own stages have: an onboarded Cloudflare Email Sending domain (every
stage refused to deploy without a mail sender), a model gateway and its key, and goblin's own hosts written into the
code (the CLI's default origin, the landing's canonical and share URLs, an agent app's egress refusing "the last two
labels" of the host). Someone deploying goblin to their own account usually has an identity provider already (mysi, an
Auth0 or Keycloak tenant, a company's IdP) and may have no mail domain and no model key to share with every account.

## Decision

- **OpenID Connect sign-in beside emailed codes.** `GOBLIN_OIDC_ISSUER`, `GOBLIN_OIDC_CLIENT_ID`,
  `GOBLIN_OIDC_CLIENT_SECRET` (a secret binding) and `GOBLIN_OIDC_LABEL` (the button's words, "Sign in with mysi";
  unset, "Sign in with" the issuer's host). With the first three set, Better Auth's `genericOAuth` plugin registers one
  provider, `oidc`: discovery from `<issuer>/.well-known/openid-configuration`, which must publish the provider's
  signing keys (`requireIdTokenVerification`; the ID token is verified and its nonce bound), PKCE, and the scopes
  `openid email profile`. In Better Auth 1.7.6 a generic provider is a social provider, so it uses the core routes
  `/api/auth/sign-in/social` and `/api/auth/callback/oidc` (the redirect URI the provider must allow); nothing it adds
  sits under the MCP provider's `/oauth2/*` or outside the auth base path. Better Auth is built per request and
  building the provider reads the discovery document, so it is built only for those two routes.
- **The same gate as an emailed code.** A provider's sign-in may create an account only as an emailed code may
  (`SIGNUP_MODE`: open, invite with the code in `x-invite-code` when the sign-in starts, or closed). The Worker decides
  that when the sign-in starts, over whatever the browser asked for, and Better Auth keeps the answer in the sign-in's
  stored state (`disableImplicitSignUp` with `requestSignUp`). An account is created only for an email the provider
  says is verified, and the provider's account joins an existing account (same email) only when the provider says the
  email is verified and the account's own email is verified too; no provider is trusted past that. goblin keeps none
  of the provider's tokens, never refreshes them, and signing out of goblin leaves the provider's session alone;
  linking or unlinking a provider by hand and the token endpoints answer 404. An MCP client's authorization goes on
  through the provider's sign-in as it does through a code (the OAuth provider plugin's signed query).
- **`/health` lists what the deployment offers.** `{ ok, service, stage, signup, signIn, features }`: `signIn` is
  `{ method: 'email' }` when mail can be sent and `{ method: 'oidc', label }` when a provider is configured;
  `features` says which optional bindings are there (`largeFiles`, `agentApps`, `flows`, `decisions`). The sign-in page
  shows the provider's button first, then the emailed code, each only when listed.
- **A deployment needs a way in, not mail.** Alchemy refuses a deploy only when neither a mail sender nor a provider is
  configured.
- **The model endpoint is optional.** The deployment's own endpoint is `GOBLIN_MODEL_BASE_URL`, `GOBLIN_MODEL_KEY` and
  `GOBLIN_MODEL_ID`, all three or none. Without it, every model call is refused with `NoModelEndpoint` (409, "Bring
  your own model key in Settings") until the owner sets their own (ADR 0059): sends, routine firings (recorded
  skipped), housekeeping and an app's `llm` power alike, and a call already under way ends with those words, which the
  chat shows. The picker offers nothing, Start's model step asks for the owner's endpoint (it can still be passed by),
  and the daily cap holds for nothing. The memory model is then the owner's endpoint's default.
- **Configuration over stage.** `STAGE` is a label only: the mail subject's prefix, robots and telemetry tags. The CLI
  takes its origin from `--origin` or `GOBLIN_ORIGIN` and has no default; the landing's canonical and share URLs are
  the deployment's own origin (`APP_URL`, which the canonical redirect makes every page's); an agent app's egress
  refuses the deployment's own host and anything under it, never a whole registrable domain (a deployment on
  `goblin.example.workers.dev` leaves its neighbours reachable). The optional bindings turn off cleanly: without the
  files bucket (`FILES`, `GOBLIN_LARGE_FILES=off`) files up to 128 KiB stay in the agent and a larger one is refused as
  too large; without Dynamic Workers (`LOADER`, `GOBLIN_AGENT_APPS=off`) the agent has no app or `code_run` tools, an
  isolate is refused and the rail has no Apps; without Analytics Engine (`FLOWS`, `GOBLIN_FLOWS=off`) no flow point is
  written; without mail or Workers AI their features are absent. None of them is needed to start.

## Consequences

- A provider's registration names `https://<host>/api/auth/callback/oidc` as its redirect URI and issues a confidential
  client (secret) for the deployment.
- A provider's sign-in reads the discovery document twice (when it starts and at the callback) and the signing keys
  once; nothing is cached across requests.
- An owner who signs in through the provider and later by code, with the same verified email, reaches the same account.
- Deploying with neither model nor mail is possible: such a deployment signs in through its provider and each owner
  brings a model key.
- goblin's own stages keep their settings: dev and prod configure mail and the model endpoint as before, and keep every
  binding.
