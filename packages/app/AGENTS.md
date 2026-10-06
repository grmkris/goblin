# App

Read the root instructions first. Owns the agent app SDK and toolchain (ADR 0021): the server SDK an app imports as
`@goblin/app`, the release entry that runs an app's code in a Dynamic Worker, the sucrase transpiler and the Tailwind
style compiler isolates, and the docs the agent reads with `app_docs`. `bun run build` bundles them into
`dist/toolchain.js` as strings; the runtime loads that only while it builds an app. Everything in `src/` outside
`src/ui/` runs inside isolates with no network and no bindings: keep it dependency-free except sucrase and Tailwind,
and the render check (`src/render.ts`), which renders a view once with React and goblin's components.
`src/ui/` is the browser frame runtime of app views (React, the UI SDK over ext-apps, goblin's components and the kit),
built into `dist/runtime/` and served by the web as hashed assets. Docs are written for low-end models: short,
concrete, with working examples.
