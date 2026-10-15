# Cleanup code checkpoint — 2026-10-15

Goblin code is integrated on `dev` at `677c349c`. The full `heavy bun run check` passed on that commit.
This is local code and fixture evidence. No push, stage reset, deployment or production promotion was performed.

## Source reply follow-up at `25f03956`

The reply tool's structured outcome now follows owner-reviewed accepted, retryable and rejected rules. Unmatched
results and uncertain transport outcomes stop without automatic replay. Calls, chunk boundaries and result rules
are frozen before dispatch; accepted pieces and an in-flight intent survive reconstruction. Retry windows are
bounded, and terminal reports recover independently of sending. The owner can edit reply result rules, which makes
a new proposal requiring confirmation. Notify me via copies the rules.

Source binding attempts have a persistent counter and conditional updates after asynchronous waits. A delayed
confirmation, alarm or unbind cannot overwrite a newer Source decision. Unicode chunk boundaries preserve code
points (`525680b4`).

Scoped validation: 31 runtime tests, 13 web tests, four native Source cases (45 unrelated cases filtered out), and
browser checks at desktop and 390px. The binding files passed type, Effect, lint and format checks. These results
do not replace a full gate on the final integrated commit. Review found related races in the underlying Events
consumer binding and shared subscription cleanup; that follow-up and the Mygram producer lane remain in progress.

A read-only dev check found healthy invite-only service and a successful CI run for `6c04e812`; this is the older
deployed release, not evidence of the cleanup release being deployed.

## Integrated behavior

- External messages use owner-confirmed Sources. The built-in Telegram transport, settings, routing and telemetry
  are removed. Mygram connects through the same MCP boundary as other services.
- Source keys keep distinct Topics even when their titles match. Dropped foreign messages do not create Topics;
  accepted owner messages keep their attachment content, including short embedded text.
- Notification copies use the owner's tool and reviewed result rules: accepted, retryable, rejected or unknown.
  Unknown outcomes do not automatically replay. Echo suppression compares the exact event selector, and every sink
  save changes its revision.
- The outbound MCP host is grouped by responsibility. A shipped-code guard prevents retired integration terms
  from returning.
- Auth and application storage each have one fresh baseline. Schema parity includes primary keys and indexes;
  the native canary verifies that applying and reapplying the application baseline preserves populated Pi/Agents
  tables and an application row. These baselines require the disposable dev reset before delivery.

## Validation at `677c349c`

| Check | Result |
| --- | --- |
| Release, promotion and CI credential helpers | 22 tests passed |
| Workspace typechecks | 8 passed |
| Lint, Effect diagnostics and Knip | 0 findings; 0 collection failures |
| Formatting, docs/agents, patches, graph, chat identities, retired terms and duplication gates | Passed |
| Runtime units | 797 passed |
| Web units | 595 passed |
| Contracts units | 51 passed |
| CLI units | 18 passed |
| Tooling units | 276 passed |
| App and kit units | 4 and 6 passed |
| Native workerd integration | 79 passed across 5 files; 0 skipped |
| Alternate-primary native integration | 73 passed across 2 files; 0 skipped |
| Build | Passed |

The unit total is 1,747; native profiles add 152 passing tests. Turbo reused valid cached tasks where applicable.
Native auth, inbox and interrupted-code fixtures now use process-specific local stages so a previous test process's
database cannot collide with the fresh auth baseline.

Separate browser fixtures exercised four Source routes, eight Events proposals and four queue checks. Source saves
survive refetch, archived Personas remain visible in the relevant review, and desktop/390px screenshots were reviewed.
These checks use local fixtures and do not establish authenticated MySI or Telegram delivery.

## Remaining delivery gates

1. Finish and review the separate Mygram lane. At this checkpoint it still needs per-entry MCP attachment blocks
   preserved through SDK/MySI, pending-media recovery that cannot advance past an undeliverable photo, text-format
   defaults, guide updates, archive/timeline proof, integration with its current base and its final checks. A retained
   cursor also needs a durable later wake; Goblin does not poll `media_read` after an empty Source page. The Source
   setup must key both `chat` and `threadId` to keep forum topics distinct, while the producer must omit a missing
   thread id rather than send JSON `null` to Mygram's optional field. Reply results also need a truthful mapping of
   structured `accepted`, `retryable`, `rejected` and `unknown` outcomes; successful MCP transport alone is not
   external delivery.
2. Follow the [reset/setup checklist](../../docs/development.md#reset-dev) for the checked release. Preserve only the
   setup checklist; dev data is disposable. Record the selected SHA, old and new Worker versions, authenticated smoke,
   drift and the exact CI acceptance receipt. Keep the production freeze in place.
3. Schedule the separately deferred [owner acceptance session](../../docs/development.md#deferred-mysi-and-mygram-live-acceptance):
   reconnect MySI, review grants and Source mappings, then verify DM/group/photo, non-owner/replay handling, outbound
   file and routine-copy delivery with actual received-message evidence.

The remaining external gates stay open until their receipts exist. A passing local check does not close them.
