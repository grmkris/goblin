# ADR 0128: The post-deploy smoke signs in for real and runs one model turn

Status: Accepted 2026-10-27 with the owner. Amends ADR 0106: every deploy's smoke runs one model turn, a pong on the
stage's cheapest model. Amends ADR 0046: prod runs the signed-in smoke too, and dev acceptance may be public while the
smoke's sign-in is not configured.

## Context

Dev's smoke signed in with a session cookie the operator captured by hand and stored as the `dev` environment's
`GOBLIN_SMOKE_SESSION` secret: it expired, every dev reset invalidated it, and it was the owner's own session in CI.
Prod's smoke was read-only, so no signed-in path was checked on prod after a deploy. ADR 0106 took every model call out
of the smoke, so whether a deployed agent still answers was nobody's check. The integrator paths (an app's install and
token, its stream and Events, an MCP client's Task; ADRs 0112, 0116, 0118, 0119) were checked by hand-run scripts.

mysi, the owner's agent infrastructure, has trusted workloads (myapps' ADR 0072): a GitHub Actions job exchanges its
own OIDC token (RFC 7523 jwt-bearer) for a 15-minute mysi token, under a policy the owner made that names the
repository, the ref, the workflow and the environment, and links one saved access. No key is stored, and other
projects can use the same mechanism.

## Decision

- **No cookie in CI.** The smoke signs in as a fixed checks account by emailed code: it takes the mailbox's cursor with
  myinbox's `address_cursor`, asks the stage to send a code, reads it with `verification_wait`, and signs in. The
  session lives in the smoke's memory only. The mailbox is read through a mysi workload whose saved access reads that
  one address. The stage's invite code goes with the sign-in, so the first deploy after a reset makes the account again.
- **The integrator paths, around one model turn.** Signed in, the smoke registers a fresh app with an https return URL,
  installs it (the redirect carries the installation, the workspace and the state) and declines it (`access_denied`).
  With the app's `client_credentials` token it reads its access, creates and lists a Topic, opens the Topic's stream
  and polls its Events. An MCP client of the account, connected by consent, sends one turn (`Reply with the single
  word: pong`) into that Topic as a Task and follows it with `tasks/get` until it completes; `tasks/get` without the
  Tasks extension is refused. The app's stream sees the turn from `MESSAGES_SNAPSHOT` to `RUN_FINISHED`, and Events
  see it too. The refusals hold: another workspace is not found, a bare `/api` path is not found, and the members list
  is forbidden. The app is deleted and the client revoked whatever failed. `GOBLIN_SMOKE_MODEL` names the stage's
  cheapest model for the turn.
- **Prod runs it too**, the same smoke as dev.
- **Skipped with a reason until configured.** Without the checks account (`GOBLIN_SMOKE_EMAIL`), its mailbox workload
  (`GOBLIN_SMOKE_MAILBOX_WORKLOAD`) or the job's OIDC request, the smoke runs the public checks and records
  `skipped: no mailbox access (<why>)`; the release's acceptance is then `public`. The release accepts `public` only
  while the account or the workload is not configured; once both are, a smoke that did not sign in fails the release.
  Promotion accepts a public dev receipt only with that reason.
- **A failure is a red run and a Telegram message, with no rollback.** A failed prod release writes a step summary that
  names the failed step, the prod commit before the push and the way back. A second workload
  (`GOBLIN_ALERT_WORKLOAD`, whose saved access is mygram's `message_send` at reply level, limited to the alerts chat)
  sends the same in one line. Nothing is rolled back: the way back is a revert on dev, promoted like any change (ADR
  0077).

## Consequences

- Every deploy spends one short turn's tokens, counted against the checks account, not the owner. ADR 0106's other
  turns stay off unless `GOBLIN_SMOKE_TURNS=1`.
- No session secret to rotate, and a dev reset needs no sign-in by hand.
- The flows check runs again: the turn writes a `send` point.
- The job's OIDC request reaches the smoke and the alert only, never the install, plan or deploy steps.
- Until the owner makes the workload policies on mysi, every deploy passes with public acceptance and says why.
- The checks account is a real account on each stage; its workspace keeps the smoke's archived Topics.

## Rejected

- **Keeping the cookie**: it expires, a reset invalidates it, and it is the owner's own session.
- **A stored key in CI**, for mysi or goblin: a long-lived secret, and goblin's keys are gone (ADR 0125).
- **Rolling back automatically**: prod moves only forward (ADR 0077), and a rollback deploy would skip the checks a
  release makes.
