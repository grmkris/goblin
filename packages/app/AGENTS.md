# App

Read the root instructions first. Owns the agent app SDK and toolchain (ADR 0021): the server SDK an app imports as
`@goblin/app`, the release entry that runs an app's code in a Dynamic Worker, the sucrase transpiler isolate, and the
docs the agent reads with `app_docs`. `bun run build` bundles them into `dist/toolchain.js` as strings; the runtime
loads that only while it builds an app. Everything in `src/` (but `toolchain.d.ts`) runs inside isolates with no
network and no bindings: keep it dependency-free except sucrase in the transpiler. Docs are written for low-end models:
short, concrete, with working examples.
