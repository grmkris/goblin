# Coding agents and skills

`AGENTS.md` is canonical. Every `CLAUDE.md` (root and nested) is a symlink to its sibling `AGENTS.md`: Grok reads only `CLAUDE.md` and ignores `@AGENTS.md` imports, and Claude Code prefers `CLAUDE.md`. `.mcp.json` is the MCP master; `bun scripts/agents-sync.ts` regenerates `.codex/config.toml` and `.cursor/mcp.json` and repairs the links (standard: grmkris/personal `infra/agents.md`). The root task map links all workspace instructions because Codex does not load files below its starting directory.

Skills live in `.agents/skills/<name>/SKILL.md`. Each Claude link is relative: `.claude/skills/<name> -> ../../.agents/skills/<name>`. Keep `.claude/skills` as a real directory of per-skill links. `agents/openai.yaml` invocation policy must agree with any Claude `disable-model-invocation` frontmatter.

`bun run agents:check` checks skill names/frontmatter, concise descriptions, unfinished placeholders, invocation policy, licenses and copy hashes, relative links, instruction shims, Cursor pointers, and documentation links. Upstream files retain their license and byte identity; goblin precedence is separate or explicitly adapted. `.agents/skills/sources.json` pins upstream repository/commit/path/hash for vendored skills.

Codex, Grok, Hermes and Cursor read `.agents/skills`; Claude uses the linked copies; Cursor needs the always-applied
`.mdc` pointer. `bun run agents:check` verifies the repository's skill discovery and instruction links.

No hooks rewrite files or run whole-tree checks on each edit in this shared checkout. Do not alter user secret/environment configuration as part of repository setup. Project Codex configuration is not an assumed secret filter.

## Skills and MCP (2026-10-10)

Vendored skills are pinned in `.agents/skills/sources.json` (v2: upstream commit, SPDX license, tree hashes,
recorded adaptations) and verified by `bun scripts/agents-sync.ts --check`, which `agents:check` runs first;
`tools/agents.ts` keeps only the repo-authored checks. The shared design, review and grilling skills come from
grmkris/personal (emil-design-eng, improve-animations and prototype retired for overlap); Cloudflare skills from
cloudflare/skills, see `cloudflare-provenance.md`. `.mcp.json` lists myplan, myinbox, mytab, mytmux, mygram and
cloudflare (OAuth). Change skills with `bun scripts/agents-sync.ts skills add`, `skills rehash` and `skills update`.
