# Documentation

Documentation describes what the code does now. When an integration or behaviour changes, update the README,
[architecture](../architecture.md), [development guide](../development.md), the relevant ADR and the matching skill in
the same commit. `bun run agents:check` verifies relative links and that every documented `bun run` script exists.

Never include tokens, private environment contents or unrun claims. Say plainly what was verified where: unit tests,
local workerd, the deployed dev instance. `docs/archive/` is frozen history and is not updated. This guide follows the
[docs-verification skill](../../.agents/skills/docs-verification/SKILL.md).
