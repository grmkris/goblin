# UI

Read the root instructions first. Shared editable shadcn components and theme primitives only. Components own their
appearance; app views consume them. Keep browser code free of server imports, credentials and deployment dependencies.
The look follows `~/code/myapps/packages/ui` (tokens, Geist, AuthPage): port from there before inventing. The app
shell (Sidebar, TopBar) is goblin's own, trimmed from shadcn's base-nova sidebar.
