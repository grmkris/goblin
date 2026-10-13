# Overnight run 2026-10-09: Topics, coding runners, decisions PR

The plan, approved by the owner on 2026-10-09 around 02:30, is the owner's private plan file. A conductor session ran
eight lanes. Codex lanes stalled repeatedly on model capacity, so most work finished in Claude
subagents. Every lane landed on `main` through review: small commits, a full gate per batch, ff-only landings or
cherry-picks.

## What is live

- **prod** (`goblin.surf`) runs `d5ac526`.
  - Release receipt: public smoke and drift verified.
  - The owner's real workspace was checked in the owner's shared Chrome: the new shell, Main's full history, threads,
    Apps, and a Ready stream.
- **dev** (`dev.goblin.surf`) runs **branch `spike/decisions` at `2ebeb4d`**, which is `main` plus PR #4 (see below).
  - `main` at `d5ac526` was released to dev first: authenticated smoke, `ui:acceptance` 0 failed, desktop and phone
    walkthrough, inbound `ask_agent` landing in "Personal topic, main conversation".
  - **Before the next prod release, redeploy `main` to dev.** `release.py` requires the live dev version to match the
    SHA being promoted.
- **`main`** is at `039ee96`. Everything after `d5ac526` is coding-spike-only (service titles, the approval-page fix),
  so the deployed Worker is unaffected.

## Shipped on main (ADRs 0030–0036)

| Feature | Where | Notes |
| --- | --- | --- |
| Logical chat ids (Phase 1) | ADR 0030 | Released earlier in the night as the baseline `9f9e0a8`. |
| Topics, one Conversation each, nested Threads, archive/restore | ADR 0032 | Personal = Main (`/c/1`). Inbound still lands in Personal. Topic seeds come from a discussion. |
| Per-Topic memory | ADR 0032 | `app_chat_memory_*`; Main's memory is copied into Personal. |
| Personas (owner- and Goblin-created, attributed, parallel / "then"), organize tools with receipts and Undo | ADR 0033 | |
| Delegate results posted passively; Goblin re-answers only when the spawn set `synthesize` | ADR 0033 | Spec §5. |
| Start thread before sending; Move to thread | ADR 0034 | Move ships the **settled-turn** version (see below). |
| Cross-Topic retrieval (FTS5, `search_chats`, automatic rerank, source strip) | ADR 0035 | |
| Slack-style shell (rail, Topics as channels, thread panel, Threads/Activity/Tasks, Persona profiles) | ADR 0036 | Replaces the pane/Trellis workspace. |

**Move to thread, running turn: no-go for now.**
- The identity swap passed its correctness tests, but after 20 chained moves the channel's reads were 3.0× an unmoved
  chat (limit 2×). Pi forks by reference and reads one query per ancestor.
- The code is kept on local branch `archive/move-swap` (`844b73a`).
- Unblocked by a Pi API to flatten a fork chain or cap its depth. That upstream ask is recorded in ADR 0034.

## PR #4 — typed decisions through Workers AI (Clef)

https://github.com/grmkris/goblin/pull/4 (branch `spike/decisions`, CI green).

**Contents:**
- ADR 0031 and the `AI` binding;
- the rules-first critic with a Clef port;
- Credits metering;
- the `app_decision_*` tables;
- three owner-confirmed judgments (Delegate attention, "could be a thread", cross-Topic context), shown as "Only
  visible to you" rows.

**Eval (`bench/reports/decisions-decisions-20261009-v4.md`, held-out set):**
- Clef is the best arm for brief, attention and separate-work; context relevance is Clef at threshold 0.594.
- Nothing is ready for automatic use.

Results are in the myplan note "Goblin decision experiments (Clef)". Dev runs this branch: try it per the PR body.

## Coding runner adapter (lane R)

Handoff: `evidence/handoffs/coding-runner-20261009.md`.

- One provider-neutral contract with three backends:
  - native (host compilers);
  - Docker (same image as Cloudflare, `--network none`, UID 1000, limits);
  - Cloudflare Containers.
- Parity, isolation and a benchmark are in `spikes/coding-cf/BENCHMARK.md`.
- Three dev connections work, each with exactly 7 tools in a dedicated chat (native 4584, Cloudflare 4589, Docker
  4594). The Docker acceptance PR was closed as evidence.
- **Stable hostnames are blocked.** `CLOUDFLARE_API_TOKEN` lacks Cloudflare Tunnel edit scope (error 10000), so the
  services run behind quick tunnels in tmux sessions:
  - `goblin-coding-runner-{native,docker,cloudflare}` (servers);
  - `…-tunnel-*` (tunnels).
- Add **Cloudflare Tunnel: Edit + DNS: Edit** to the token, and the named-tunnel stack in
  `spikes/coding-cf/scripts/tunnel.ts` gives `coding-{native,docker,cf}.goblin.surf`. Connections then need
  reconnecting.

## Morning steps for the owner

1. **Prod coding connections.** On goblin.surf → Connections:
   - The native server is already added (`shapes-encounter-…`, "Not connected"). Press **Connect**.
   - On the approval page, run `bun spikes/coding/scripts/approval-code.ts native` in the goblin checkout and paste the
     code from `.local/coding-runner/native-prod-approval.txt`. Codes are single-use and valid for 30 minutes.
   - Then allow the 7 coding tools.
   - Add the other two **By address** and repeat with `docker` / `cloudflare`:
     - `https://yamaha-databases-pole-soonest.trycloudflare.com/mcp` (Docker);
     - `https://assessed-chairs-characteristics-photographer.trycloudflare.com/mcp` (Cloudflare).
   - The conductor stopped short of typing approval codes into the owner's browser.
2. **Review PR #4.** Merge it or leave it. If merged, release `main` (dev, then prod) as usual.
3. **Token scopes for stable coding hostnames** (above).

## Owner-facing flags found during the night

- **E3 cost:** automatic retrieval adds a cheap-model rerank on most first requests that pass the bm25 gate. That
  costs latency and daily budget; it is metered.
- **Undo after Undo:** undoing "Created persona" leaves an "Archived persona" receipt that itself has Undo.
- **Move with a pending question:** Move proceeds while an `ask_user` question is pending. Only `awaiting_approval`
  refuses.
- **Panel overlay:** around 1180px the thread panel overlays part of the channel composer.
- **Excerpt prefixes:** source excerpts start with "user:" / "assistant:".
- **Hidden tabs:** a channel opens its stream only while on screen, so a hidden tab shows "Connecting…" until viewed.
  This is by design.
- **Retrieval follow-up:** fused hybrid retrieval reached 94.3% recall@5 against 85.7% for FTS
  (`bench/retrieval-report.md`). Clef as a reranker is not worth it.

## Fixes made along the way

| Commit | Fix |
| --- | --- |
| `9f9e0a8` | CI lacked the `spikes/coding-cf` install. |
| `38abec3` | `/var` filled with release snapshots (2.6 GB each); releases now prune non-live snapshots. |
| `98c9611` | The smoke expected the old Delegate input-then-answer pair. |
| `d5ac526` | The public smoke didn't follow Home's redirect. |
| `039ee96` | The coding approval page sent `Referrer-Policy: no-referrer`, so browsers posted `Origin: null`. |

## Evidence and spend

- **Spend:** decisions about $0.41 (plus the settled $0.0118 attempt) and retrieval about $0.44 conservative, against
  the $5 cap.
- **Private evidence:**
  - `.local/bench/{decisions,retrieval-lane-20261009}`;
  - `.local/goblin-acceptance/` (screenshots, UI acceptance receipts);
  - `.local/coding-{spike,cf-spike,runner}`;
  - release receipts in `/var/lib/goblin-release/receipts/`.
- **Cleanup done:**
  - PRs #1–#3 closed with evidence comments, and their branches deleted;
  - 11 merged local branches pruned;
  - every lane worktree removed except `goblin-wt-decisions` (it holds the deployed PR branch);
  - Codex panes closed;
  - the throwaway Vectorize index deleted.
- **Spec:** the myplan spec rev 10 has the round-4 amendments and §12, the technical appendix and go/no-go.
