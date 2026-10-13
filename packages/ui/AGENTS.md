# UI

Read the root instructions first. Shared editable shadcn components and theme primitives only. Components own their
appearance; app views consume them. Keep browser code free of server imports, credentials and deployment dependencies.
The look follows the myapps checkout's `packages/ui` (tokens, Geist, AuthPage): port from there before inventing. The
app's shell (the moss rail and sidebar, `apps/web/src/components/shell`) is goblin's own; this package keeps its tokens
(`--shell-*`, `--moss`) and the TopBar.
