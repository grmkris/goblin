# Coding agents and skills

`AGENTS.md` is canonical. Root `CLAUDE.md` imports it with `@AGENTS.md`; each nested workspace has the same one-line shim. The root task map links all workspace instructions because Codex does not load files below its starting directory.

Skills live in `.agents/skills/<name>/SKILL.md`. Each Claude link is relative: `.claude/skills/<name> -> ../../.agents/skills/<name>`. Keep `.claude/skills` as a real directory of per-skill links. `agents/openai.yaml` invocation policy must agree with any Claude `disable-model-invocation` frontmatter.

`bun run agents:check` checks skill names/frontmatter, concise descriptions, unfinished placeholders, invocation policy, licenses and copy hashes, relative links, instruction shims, Cursor pointers, and documentation links. Upstream files retain their license and byte identity; Purrable precedence is separate or explicitly adapted. `.agents/skills/sources.json` pins upstream repository/commit/path/hash for vendored skills.

Codex, Grok, Hermes and Cursor read `.agents/skills`; Claude uses the linked copies; Cursor needs the always-applied
`.mdc` pointer. Fresh Codex and Claude sessions listed every repository skill on 2026-10-04
([receipt](../archive/2026-10-04-initial-slice/evidence/skill-discovery.json)).

No hooks rewrite files or run whole-tree checks on each edit in this shared checkout. Do not alter user secret/environment configuration as part of repository setup. Project Codex configuration is not an assumed secret filter.
