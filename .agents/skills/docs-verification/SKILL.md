---
name: docs-verification
description: Keep Purrable's README, architecture, development guide, ADRs and skills accurate when code or integrations change.
---

# Docs in Purrable

Docs describe what the code does now, in plain terms.

- Update README, `docs/architecture.md`, `docs/development.md`, the relevant ADR and the matching skill in the same
  commit as the behaviour change.
- Say where a claim was verified: unit test, local workerd, or the deployed dev instance. Unrun claims stay out.
- Beta/experimental dependencies (PiHarness, Pi Durable, Alchemy, Drizzle RC) are named as such.
- Never include tokens, private settings or remote personal content.
- `docs/archive/` is frozen history; do not update it.
- Read installed type declarations before documenting an API signature.

`bun run agents:check` verifies relative links and that documented `bun run` scripts exist.
