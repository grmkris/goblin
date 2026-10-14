#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$(cd ../.. && pwd)"
heavy docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cargo -e RUSTUP_HOME=/rustup \
  -e PATH=/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e CARGO_BUILD_JOBS=4 \
  -v "${CARGO_HOME:-$HOME/.cargo}:/cargo" -v "${RUSTUP_HOME:-$HOME/.rustup}:/rustup:ro" \
  -v "$repo:/work" -w /work/spikes/desktop \
  goblin-desktop-spike:20261014 cargo "${@:-build}"
