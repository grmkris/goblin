# prod is the repository's default branch

Accepted (owner, 2026-10-16). Amends ADR 0046, which made `dev` the default branch.

GitHub's default branch is `prod`: someone who lands on the repository, or clones it, sees what goblin.surf runs, not
work in progress. Nothing else about the branches changes: every change still lands on `dev`, CI still deploys dev from
`dev` and prod from `prod`, and `bun run promote <sha>` is still the only way `prod` moves.

What the default used to decide now has to be said: branch from `dev` (`git switch dev` after a fresh clone) and base
every pull request on it (`gh pr create --base dev`). A pull request against `prod` would not deploy: Deploy prod
requires a fast-forward to a SHA with its own dev acceptance.
