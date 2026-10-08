# UI follow-up coordination

Codex is implementing the approved UI follow-up on main in parallel with the composer/reference agent. The owner asked
for coordination and for the UI agent to clean up after the composer work, preserving it.

The first UI commit is `ad44421`: editable fields are at least 16px, code inputs remain 18px, hybrid touch targets and
Return/newline behavior are safe. It includes the rename Input pill variant. Please preserve these changes when editing
the composer or conversation pane.

UI-owned work: shared component variants/styles, Home note reader/highlight/removal feedback, keyboard inset and phone
chat snap behavior, and UI acceptance tooling. Attachment error/retry behavior will be integrated after the portable
AttachmentDraft/composer work settles. No runtime or contracts changes belong to this UI agent.

Please leave a handoff with your final commit and any deferred checks. Do not broadly stage, reset, stash or restore
the shared checkout. UI commits will stage only exact UI-owned paths or hunks.

Status update: Codex is continuing in parallel in this shared checkout. The current cleanup touches the other agent's
attachment draft only to add retry/remove/error blocking, while preserving its portable draft and composer contracts.
Home feedback and shared styling remain Codex-owned. Please avoid resetting or broad-staging these paths.

Home feedback is committed as `21085c2`. CSS layering/variants and the acceptance matrix are in progress. The portable
attachment draft now has retry/source retention, and failed uploads block submit. Please preserve those additions.
The composer must keep `(pointer: coarse), (any-pointer: coarse)` in its Return-key detection; the later Field rewrite
temporarily lost the any-pointer clause and Codex restored it. A source-composer hybrid check now covers it.
No accessible Goblin tmux pane or agent mailbox was found; this file is the coordination channel.

CSS variants/layering landed as `52e3fed`; read-only acceptance tooling as `329c87f`. Codex is committing the portable
AttachmentDraft extraction plus retry/error UI as one attachment change so the composer work can build on it. The
composer rewrite and composer-state remain yours; their failed-upload blocking and hybrid Return behavior are already
present in the working copy. Codex will stage only the corresponding two-line blocking fix in the pre-rewrite composer.

Coordination update (2026-10-08): the parallel composer agent's tracked work is committed as `6c178e8` and
`322e228`. The Codex task server is available now. I messaged both that agent and the coding-spike agent to confirm
that I am working in parallel, will preserve their files, and currently own only the design-skill packaging and this
handoff. The composer agent owns its Dev smoke investigation (`thread_submit_failed`, HTTP 500); production remains
blocked on its passing Dev receipt.

The full local gate passed release tests, formatting, agent checks, shadcn patch checks, graph checks, and all nine
workspace typechecks. `lint:gate` then reported only two untracked spike files:
`spikes/coding/scripts/github.ts:0:knip knip(files)` and `spikes/coding/scripts/overlay.ts:0:knip knip(files)`.
The coding agent is actively adding the rest of that experiment. No UI agent changes or ignores those paths. The
finding is attributed to the in-progress untracked spike until its import graph and entrypoint settle.

The source Chromium UI matrix passed 19 checks with zero page errors: phone, landscape, tablet, desktop and hybrid
editable fields; Return behavior; note scroll/focus return; synthetic keyboard and pinch-zoom handling; attachment
failure/retry/remove/send blocking; Home feedback/frame preservation; Thoughts closure; and style samples. Its receipt
is `.local/goblin-acceptance/local-1791475280289/receipt.json`. Five viewport screenshots are byte-identical to the
pre-layer baseline in `.local/goblin-acceptance/local-1791474422477/`. Attachment and keyboard Vitest passed 6 tests.
The parallel source-composer run also passed, including IME, skill-only sends, references and draft transfer:
`.local/goblin-acceptance/composer-1791475092900/receipt.json`. These are local source-fixture checks; physical iOS and
authenticated deployed UI behavior require separate evidence.

UI follow-up commits: `ad44421` (editable fields and hybrid touch), `116b29a` (keyboard, phone chat and note reading),
`21085c2` (Home feedback), `52e3fed` (explicit variants and CSS layering), `329c87f` (honest read-only acceptance),
`6ac31ab` (portable attachments, failure retention/retry and blocked sends), `18bab80` (local browser coverage), and
`a5e1a41` (design-skill packaging with source commits, adapted hashes, MIT licenses and matching invocation metadata).
The temporary stylesheet regression in `3f1dbff` was corrected by `7952a91`; the final composer styles belong to the
parallel agent's `6c178e8`. No history was rewritten.

After `a5e1a41`, scoped skill formatting and `bun run agents:check` passed. `heavy bun run check:fast` passed all three
release-script tests, then formatting stopped on 10 in-progress files in the untracked coding spike: `package.json`,
`github.ts`, `lsp.ts`, `oauth.ts`, `overlay.ts`, `prepare.ts`, `server.ts`, `state.ts`, `tools.ts`, and `verifier.ts`.
Their owner received the exact blocker through the Codex task server. No UI or skill-owned path was reported by that
gate. The complete local gate remains unproven; later steps did not run after formatting failed. Other agents' live
files and unrelated captures remain preserved, and no deployment was performed by this UI task.
