# Coding agents and skills

`AGENTS.md` is canonical. Every `CLAUDE.md` (root and nested) is a symlink to its sibling `AGENTS.md`: Grok reads only `CLAUDE.md` and ignores `@AGENTS.md` imports, and Claude Code prefers `CLAUDE.md`. `.mcp.json` is the MCP master; `bun scripts/agents-sync.ts` regenerates `.codex/config.toml` and `.cursor/mcp.json` and repairs the links (standard: grmkris/personal `infra/agents.md`). The root task map links all workspace instructions because Codex does not load files below its starting directory.

Skills live in `.agents/skills/<name>/SKILL.md`. Each Claude link is relative: `.claude/skills/<name> -> ../../.agents/skills/<name>`. Keep `.claude/skills` as a real directory of per-skill links. `agents/openai.yaml` invocation policy must agree with any Claude `disable-model-invocation` frontmatter.

`bun run agents:check` checks skill names/frontmatter, concise descriptions, unfinished placeholders, invocation policy, licenses and copy hashes, relative links, instruction shims, Cursor pointers, and documentation links. Upstream files retain their license and byte identity; goblin precedence is separate or explicitly adapted. `.agents/skills/sources.json` pins upstream repository/commit/path/hash for vendored skills.

Codex, Grok, Hermes and Cursor read `.agents/skills`; Claude uses the linked copies; Cursor needs the always-applied
`.mdc` pointer. `bun run agents:check` verifies the repository's skill discovery and instruction links.

No hooks rewrite files or run whole-tree checks on each edit in this shared checkout. Do not alter user secret/environment configuration as part of repository setup. Project Codex configuration is not an assumed secret filter.
