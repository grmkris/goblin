# Handoff: Topics, Personas, Delegates spike and research (2026-10-08/09)

The owner (Kristjan) approved a spike and research plan for the myplan spec "Goblin Topics, Personas, Delegates, and MCP
App Surfaces". This file is where the next agent picks it up.

## Sources of truth

- **Spec** (myplan, Work workspace `ws_YTK4h3a0VC3Od7DXRUvS`):
  https://myplan.lol/n/doc_79n51n9na6htxepmwzp8v1pmt0. It is at rev 7. Rounds 2 and 3 are recorded in §10
  "Amendments". Another agent (Goblin) added a separate "Operational decisions" section; leave it alone.
- **Decision experiments note:** https://myplan.lol/n/doc_3t71vd4hrs23p2cwq438tn2awq. It holds the 8 rejected
  "Decision API" suggestions, rewritten around the rules-first "critic" pattern with Cloudflare Clef.
- **Approved plan:** `~/.claude/plans/resilient-whistling-sparkle.md`. It has the phases, lanes, the Move-to-thread
  design (Phase 3a) and the kill criteria.
- **Project memory:** `~/.claude/projects/-home-kristjan-code-goblin/memory/goblin-topics-spike-plan.md`.

## Owner decisions

**Round 1 (grilling).**
- The logical chat-id refactor is done properly and lands on main.
- Move to thread is an identity swap. Pi cannot move a running turn between sessions, so the running session becomes
  the Thread and a fork cut before the moved message becomes the original chat.
- Persona mechanics: spike both options, fork + attributed write-back and a per-turn persona/model swap.
- Inbound channels (Telegram, inbound MCP) land in Personal's conversation. Routines report to their owning Topic.
- Decision models (Clef) are integrated as proposals the owner confirms, and the confirms and dismissals are kept as
  labels.
- Retrieval: spike FTS5 inside the Durable Object and Vectorize side by side.
- Widgets are deferred. Overview has no Widgets.
- Allowed v1 cuts: Persona dependency inference, live references, undo that preserves later edits, archive pausing
  schedules.
- dev.goblin.surf holds test data only, but migrations stay additive.

**Round 3 (after the first mockup).**
- **One Conversation per Topic.** Every other chat is a Thread, nested to any depth.
- Set as primary and Start conversation are dropped. New thread starts an empty Thread.
- The sidebar shows Topics plus one flat level.

**Mockup round 4 (latest; supersedes round 3's "click opens Overview").** The UI follows **Slack patterns**:
- **Layout:** three columns. A rail with Home, Threads, Activity (= Needs you) and Tasks (= Delegated work). A sidebar
  with Topics as `#channels` and Personas as @-mentionable apps (click opens a profile, not a DM). Then the channel.
- **Topic click:** opens the channel's messages. The brief is a **Canvas** tab.
- **Threads:** "Reply in thread" on any message (= Explore from here) shows "n replies · last reply …" under the
  message and opens a right-hand panel. Nested threads stack inside the panel, with a back crumb.
- **Move to thread:** the user message stays in the channel as the thread head, and the reply continues in the
  thread.
- **Start thread before sending:** a composer toggle. The message posts as a thread head and the reply lands in the
  thread.
- **Suggestions:** Clef suggestions appear as "Only visible to you" ephemeral messages with Add and Dismiss.
- **Delegates:** bot messages that show progress and then become the result.
- **Look:** a moss-green rail and sidebar, a warm off-white message area, Geist. Almost no explainer text.

## Done (on local main, NOT pushed; main is 21 ahead of origin, including other agents' commits)

- `4247dd2`: AGENTS.md now says dev holds test data only.
- **Phase 1, logical chat ids** (`c0b0d85..4d642a8`, ADR 0030). `app_conversations.session_id` is the chat id; new
  `pi_session`/`epoch`/`role`/`spawner_session` columns; the `app_chat_operations` ledger; `ChatDirectory`/`Chats` in
  `apps/runtime/src/chats/directory.ts`; `PRIMARY_CHAT`; the `check:chat-ids` gate; and a permuted-primary native
  profile (`vitest.permuted.config.ts`). Full gate green after the rebase: 228 unit, 55 native and 44 permuted tests.
  **Not deployed to dev yet.**
- **Retrieval spike** (`edf348a`, `bench/retrieval-report.md`). FTS5 works in DO SQLite: trigram tokenizer, bm25, the
  existing raw-SQL migration path, `app_` shadow tables.
  - recall@5: 100% exact, 68% paraphrase, 82.9% overall. Cheap rerank: 85.7%, and it abstained on all absent queries.
  - Recommendation: an FTS5 baseline plus a relevance/abstention gate; consider hybrid only after Vectorize is
    measured.
  - The corpus is generated and hash-checked, never committed.
- **Decision eval** (`041a0e8..39d0bab`, `bench/reports/decisions-decisions-20261008-v3.md`).
  - Dev set: rules looked best. On an independent 100-case held-out set (written blind to the rules,
    `bench/fixtures/decisions-heldout.json`) the rules scored 37/100, so they overfit. A partial cheap-model run judged
    79/104 rows.
  - The lane's own report says nothing is ready for automatic use.
- **Mockup v1** (old IA, not the Slack design) is served from
  `/tmp/goblin-lanes/20261008/mockup/site/index.html`. The server is a `python3 -m http.server 8767 --bind
  100.105.51.45` started from this session, so it stops when the session closes. Restart it with the same command
  from that directory.

## Blocked and waiting on the owner

1. **Decision lane spend guard.** Held-out attempt `decisions-heldout-20261008.536` was interrupted when a Codex
   session restarted, so its usage is unknown. The harness fails closed and refuses all further paid calls. Clef,
   Jev and OpenAI arms cannot run until the owner decides how to settle that attempt. Do not bypass the guard without
   the owner's explicit decision.
2. **Credentials** (in `~/.config/secrets.env`, mode 600; never print them):
   - the owner says the existing `CLOUDFLARE_API_TOKEN` was updated with Workers AI (+Vectorize?) permissions;
     **unverified**;
   - `JEV_API_KEY` (TypeSafe direct) was added;
   - `OPENAI_DECISIONS_API_KEY` was added. CLIProxy returns 404 for `/v1/decisions`, so call it directly.
   - The owner plans to rotate all keys before prod.

## Next steps, in order

1. Verify the Cloudflare token can reach Workers AI (`@cf/cloudflare/clef`) and Vectorize, then rerun the retrieval
   lane's Arm B (Vectorize plus a bge-m3-class embedding) and the Clef rerank on the same frozen corpus. It creates
   one throwaway index, `goblin-spike-retrieval`, and must delete it afterwards.
2. Once the owner settles the spend guard, rerun the decision eval's Clef, Clef-flash, Jev-direct and OpenAI arms on
   the dev and held-out sets, with the dev thresholds frozen.
3. Deploy Phase 1 to dev from a clean worktree (copy `.local/*.env` and `apps/web/.alchemy/state` in and back), then
   `bun run smoke:dev`. Check that main, threads and subagents behave as before, and that inbound `ask_agent` still
   reaches main.
4. Rebuild the mockup with the Slack design above.
5. **Phase 3a, Move to thread.** Follow the identity-swap design in the plan file: preconditions, the
   `app_chat_moves` state machine (cut → swap → settle → reconcile), the 9 native tests, and the kill criteria.
   **Phase 3b, Persona bench:** compare the fork + write-back arm against the per-turn swap arm in `bench/`.
6. Phase 4, the Topic data model: one Conversation per Topic, `app_topics`, membership kept separate from ancestry,
   brief entries, and per-Topic memory tables (today's memory tables are single-chat).
7. Phase 5, the freeze: a technical appendix in the spec, go/no-go per feature, and the implementation plan.

## Environment gotchas

- **Worktrees** need CI's four installs: `bun install --frozen-lockfile` at the root, then again in
  `scripts/fixtures/mcp-app`, `spikes/coding` and `spikes/coding-cf`. Without them the gates raise false Knip/lint
  failures.
- **Ports:** a foreign process holds 18983. Set `GOBLIN_HARNESS_PORT` to an unused base such as 19101, 19201, 19301
  or 19401; the harness uses offsets +10, +40, +50 and +60.
- **`heavy`:** exit 75 means retry later. Never pipe it.
- **Shared checkout:** `~/code/goblin` holds other agents' uncommitted edits. Land by cherry-picking or rebasing in a
  separate worktree, run the full gate there, then `git merge --ff-only` into main. Squash before landing if a
  branch ever committed a large blob.
- **Codex TUI lanes** in tern drop off the shared app-server ("Reconnect failed"), stop on "model at capacity", or
  show "Conversation interrupted". Resume them with
  `codex resume <uuid> -m gpt-6.1-sol --dangerously-bypass-approvals-and-sandbox "<re-orient>"`, or use gpt-6-sol
  when gpt-6.1-sol is at capacity.
- **Lane records:** briefs, status and steer files are in `/tmp/goblin-lanes/20261008/<lane>/`. Codex session UUIDs:
  - chats `01a11cd6-4de0-7cf1-a272-76e88058bd93`
  - decisions `01a11cd6-502e-7b53-8aab-03cdd45e411b`
  - retrieval `01a11cd6-543f-7a50-a65e-68d04713957d`

## Leftovers to clean when no longer needed

- **Worktrees:**
  - `~/code/goblin-land-chats` (`land/chats`; holds copies of `.local/*.env`, so remove it first);
  - `~/code/goblin-wt-chats` (`chats/logical-ids`, landed);
  - `~/code/goblin-wt-retrieval` (`spike/retrieval`, landed; reuse it for Arm B);
  - `~/code/goblin-wt-decisions` (`spike/decisions`, landed; reuse it for the provider arms).
- **Tern tabs:** the three Codex lane tabs. Nothing is running in them.
