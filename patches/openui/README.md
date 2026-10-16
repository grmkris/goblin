# OpenUI inspector

OpenUI React Lang 1.0.1 automatically mounts its inspector when imported in development. Goblin renders private
conversations, so importing a reply renderer must not mount an inspection UI or load its assets. The package patch
makes that bootstrap unreachable in both ESM and CommonJS. `publishObservability={false}` also keeps each reply
out of the library's observability store. Production and development use the same renderer.

The change is recorded in `inspector.diff`; both patched entrypoints start with its SHA-256 marker, and
`bun run check:patches` checks it in the ESM entry the app imports. When upgrading OpenUI, inspect its bootstrap and observability behavior, regenerate the
patch with `bun patch`, and rerun the browser's no-external-request checks in both development and built modes.
