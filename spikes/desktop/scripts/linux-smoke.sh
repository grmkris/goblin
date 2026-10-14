#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$(cd ../.. && pwd)"
case "${1:-}" in
  gpui|tauri|electrobun) ;;
  *) echo 'Usage: bash scripts/linux-smoke.sh <gpui|tauri|electrobun>' >&2; exit 64 ;;
esac
heavy docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v "$repo:/work" -w /work/spikes/desktop \
  goblin-desktop-spike:20261014 python3 scripts/linux-smoke.py "$1"
