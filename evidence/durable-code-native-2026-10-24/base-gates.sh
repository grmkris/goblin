#!/usr/bin/env bash
set -u
root="$PWD"
base="$root/.local/native/base-e06"
git worktree add --detach "$base" e06aae340b9b942343ebc7c36b7e024a401a1897 || exit $?
ln -s "$root/node_modules" "$base/node_modules"
for rel in apps/runtime apps/web apps/cli apps/openui-spike packages/app packages/contracts packages/ui packages/kit tools; do
  if [ -d "$root/$rel/node_modules" ]; then ln -s "$root/$rel/node_modules" "$base/$rel/node_modules"; fi
done
git -C "$base" diff --exit-code HEAD > .local/native/base-source-diff.txt || exit $?
for gate in check lint:gate; do
  label="${gate//:/-}"
  while true; do
    (cd "$base" && heavy bun run "$gate") > "$root/.local/native/base-$label.log" 2>&1
    gate_rc=$?
    if [ "$gate_rc" -eq 75 ]; then printf '%s: busy\n' "$gate"; sleep 15; continue; fi
    printf '%s\n' "$gate_rc" > "$root/.local/native/base-$label.exit"
    tail -14 "$root/.local/native/base-$label.log"
    break
  done
done
git -C "$base" diff --exit-code HEAD > .local/native/base-source-diff-after.txt
# This checkout and its only untracked dependency symlinks were created by this script.
git worktree remove --force "$base"
