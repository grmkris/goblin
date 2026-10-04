# Coding agents and skills

`AGENTS.md` is canonical. Root `CLAUDE.md` imports it with `@AGENTS.md`; each nested workspace has the same one-line shim. The root task map links all workspace instructions because Codex does not load files below its starting directory.

Skills live in `.agents/skills/<name>/SKILL.md`. Each Claude link is relative: `.claude/skills/<name> -> ../../.agents/skills/<name>`. Keep `.claude/skills` as a real directory of per-skill links. `agents/openai.yaml` invocation policy must agree with any Claude `disable-model-invocation` frontmatter.

`bun run agents:check` checks skill names/frontmatter, concise descriptions, unfinished placeholders, invocation policy, licenses and copy hashes, relative links, instruction shims, Cursor pointers, and documentation links. Upstream files retain their license and byte identity; Purrable precedence is separate or explicitly adapted. `.agents/skills/sources.json` pins upstream repository/commit/path/hash; `tools/quality-provenance.json` pins rule tooling.

The reviewed MyApps setup supports Codex, Claude, Grok, Cursor, and Hermes. Codex/Grok/Hermes/Cursor use `.agents/skills`;
Claude uses the linked copies. Cursor needs an always-applied `.mdc` pointer. On 2026-10-04, a fresh read-only Codex
session listed all 14 repository skills without invoking tools; a fresh Claude session's initialization catalog also
listed all 14 relative-linked skills. Both used GPT 6.1 Sol through the existing CLIProxy. See
[the sanitized discovery receipt](../archive/2026-10-04-initial-slice/evidence/skill-discovery.json). Grok, Cursor and Hermes have adapter checks but
no fresh-client discovery proof.

The [official Codex skills page](https://developers.openai.com/codex/skills/) was retrieved with HTTP 200 on 2026-10-04
(redirected to the current build-skills documentation). Retrieval of the
[official Claude skills page](https://code.claude.com/docs/en/skills) returned HTTP 403; current official-page review
remains a gap, distinct from the verified live client catalog and installed relative links.

No hooks rewrite files or run whole-tree checks on each edit in this shared checkout. Do not alter user secret/environment configuration as part of repository setup. Project Codex configuration is not an assumed secret filter.
