---
name: runtime-tests
description: Run or design Purrable unit, Workers, Durable Object, and isolated dev tests while preserving evidence boundaries. Use for test changes or failures.
---

# Purrable runtime tests

Choose a test that proves the claim being made: pure unit tests, workerd/Workers harness behavior, Durable Object reconstruction, and isolated Cloudflare dev acceptance are separate evidence classes.

- Use Vitest 5 and the selected Cloudflare Workers test harness. Keep harness ports configurable and evidence output in a fresh owned directory.
- Run one harness stack at a time when the harness provider requires it. Never add a destroy step to clean up Alchemy state.
- Prove PiHarness initialization, persisted state readback, and reconstruction as separate operations; a second read from one live object is not restart proof.
- Test grants and authorization before model/MCP/App calls. Do not put credentials in fixtures, transcripts, browser bundles, logs, or iframe state.
- Prefer injected services/layers over module mocks. Do not use `vi.mock`; preserve public MCP and AG-UI contracts with focused integration tests.
- Keep snapshots as contracts. Regenerate only for an intentional contract change and record that change.
- Report provider, network, authentication, and deployment gaps as unknown; synthetic tests do not prove real-host behavior.

Use the repository's scoped check first, then the heavy gate only when the coordinator assigns a slot.
