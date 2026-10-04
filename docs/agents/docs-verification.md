# Documentation verification

Documentation changes must match the pinned source and the evidence actually run. Record the package version, entrypoint/API, official URL and review date when an API claim changes. Installed declarations and source hashes belong in the compatibility report; dirty local adaptations are not upstream evidence.

Use `bun run check:files <owned paths>` for the focused loop. The coordinator runs the full `bun run check` and any deployment or provider acceptance checks. A local test, workerd reconstruction, browser interaction, provider probe, and dev deployment are distinct evidence classes; label each one explicitly. If official documentation is unavailable, record the URL, date, and blocker rather than claiming current validation.

Keep architecture, ADRs, AGENTS instructions, skills, and compatibility reports consistent. Never include tokens, private environment contents, or unrun deployment claims in documentation. This guide follows the [docs-verification skill](../../.agents/skills/docs-verification/SKILL.md), reviewed 2026-10-04.
