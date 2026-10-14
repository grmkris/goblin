# Desktop benchmark instrumentation handoff

The benchmark tools are implemented and validated locally on Linux. This is harness validation, not a performance
ranking or macOS benchmark result. The prior Mac handback established arm64 builds/process launches; the new tools
still need to run on that Mac.

- Desktop `bun run check`: pass — typecheck, six service tests (32 assertions), eight Python sampler/runner tests,
  web build, and 12 Chromium acceptance checks.
- `bun run benchmark:browser -- --trials 1 --seconds 1 ...`: pass — one 204-row idle workload and one 206-row
  streaming workload. Frame-callback and scroll-step samples are scheduling/JavaScript proxies only.
- Native runner: all three actual shells passed one warmup and two measured Linux/Xvfb trials, with one-second
  resource samples. Readiness, 204-message fixture setup, process accounting, SSE timing and cleanup were exercised.
  These short development/software-graphics trials do not establish comparative startup, memory or frame performance.
- Locked Cargo workspace tests in the disposable Linux dependency image: pass — one GPUI test, zero Tauri tests.
  Both native binaries rebuilt; Electrobun build/typecheck also passed. Direct Linux-host Cargo testing requires the
  absent pkg-config/GTK development dependencies; use the documented container instead of installing them on the box.
- Scoped Oxlint, formatting, Rust formatting and Python syntax/regression checks: pass.
- Repository-wide `heavy bun run check`: stops at the pre-existing formatting issue in
  `spikes/mobile/evidence/native-toolkit-research-2026-10-14.md`. No whole-repository green claim.

`DESKTOP_READY` means the native window constructor returned, not first paint or a rendered conversation. It is
disabled unless `GOBLIN_DESKTOP_BENCH=1` is set. The runner uses isolated fixture companions and temporary connection
files, discards arbitrary host logs, and retains failed trials. Resource totals include the companion but can omit
reparented WebView helpers; RSS remains distinct from private footprint. Artifact inventories are shell-only, not
complete installers. No live login, model request, push or deployment was performed.

Use the README's automated benchmark commands. Mac native input, IME, VoiceOver/AX, screen capture, Metal presentation
timing, private-footprint attribution and signed packaging remain separate checks.
