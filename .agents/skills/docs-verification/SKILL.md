---
name: docs-verification
description: Update Purrable documentation, dependency compatibility reports, source/skill provenance, command links, and evidence status when integrations change.
---

# Docs Verification in Purrable

Fast-moving APIs require current official docs plus installed source/type evidence. Compatibility reports separate implementation from proof.

- Record official source URL, review date, exact dependency version, package entrypoint, tested API/example, source hashes/license, and evidence environment.
- Preserve source checkout status; dirty working files are adaptations, not commit-pinned source bytes.
- Run agent/provenance and compatibility checks plus local link/command/config-owner checks. Missing or malformed evidence must fail rather than silently pass.
- Distinguish pure unit, workerd, reconstruction, browser interaction, isolated dev deployment, real-server auth, and provider evidence.
- Mark experimental/beta status and unsupported assumptions explicitly. Upstream package version 1.x does not remove experimental status.
- Keep scope/invariants consistent across AGENTS, architecture, ADRs, skills and compatibility reports in the same change.
- When official docs cannot be reached, record the source, date and exact blocker; source-only verification is an evidence gap, not current official validation.

Read the current [official documentation](https://developers.cloudflare.com/agents/harnesses/pi/), installed declarations, and `docs/stack-compatibility.md` (MCP also uses `docs/mcp-compatibility.md`) before changing API signatures. Verification date: 2026-10-04. Direct dependency pins and source evidence live in the root lockfile and compatibility records; this skill intentionally does not claim unrun runtime/provider/deployment proof.

Use `bun run check:files <owned paths>` for the inner loop, then the canonical root gate when assigned capacity. This skill does not authorize model calls, external messages, spending, deployment, or production promotion by itself.
