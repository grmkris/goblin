---
name: goblin-review
description: Review a commit range with both thermo-nuclear rubrics (correctness and maintainability) plus this repo's AGENTS.md rules, then deduplicate. Run only when invoked by name.
disable-model-invocation: true
---

# Review a commit range

A review covers a **commit range** that the user names, for example `abc123..HEAD` or "my last 5 commits", or a
branch/PR diff when one exists. If the range is unclear, ask for it.

The review is **read-only** unless the user asks for fixes. Never touch uncommitted changes you did not make.

## Steps

1. **Collect the change.** Run `git log --oneline <range>`, `git diff --stat <range>` and `git diff <range>`. Read the
   touched files in full, not only the hunks.
2. **Review on three axes.** If your harness has sub-agents, give each axis its own sub-agent with the range. If not,
   run the axes one after another.
   - **Correctness and security:** follow `.agents/skills/thermo-nuclear-review/SKILL.md`. Its "check the PR
     discussion" step applies only when a PR exists.
   - **Maintainability:** follow `.agents/skills/thermo-nuclear-code-quality-review/SKILL.md`.
   - **Repository rules:** check the change against `AGENTS.md` and the nested `AGENTS.md` of every touched
     directory. Look for:
     - runtime invariants from AGENTS.md (one Agents SDK Durable Object per user, Pi Durable for conversations);
     - Effect composition and Alchemy-owned infrastructure;
     - provider secrets never in code, logs or chat;
     - explicit-path staging; lane ownership respected;
     - workspace AGENTS.md rules for every touched package.
3. **Merge the findings.** Deduplicate across axes, keep the strongest evidence for each, and drop anything you could
   not trace end to end.
4. **Report.** List findings by severity, each with `file:line`, what goes wrong, and a concrete fix. Name the axis
   that found each one.

Over-reporting costs trust. Report only findings you would defend line by line.
