# Goblin desktop comparison

Three desktop clients for the same chat experiment: GPUI Kit 0.7.3, Tauri 2.12.3, and Electrobun 2.0.2
(Hutch 0.27.1). This is an isolated spike, not a change to Goblin's shipped web or mobile clients.

## Run on your Mac

Install Xcode command line tools (`xcode-select --install`), Rust >=1.93, Bun >=1.4.2, Node >=22, and Python >=3.9.
Mac arm64 build/process-launch checks passed with Rust 1.99 and Bun 1.4.3; Rust 1.93 is the observed dependency floor,
not a separately tested toolchain. The Electrobun dev build can warn that `electrobun/icon.iconset` is missing; this
spike has no finished Mac icon assets. Resolve that warning before packaging a distribution. The CLI Bun version
can differ from Electrobun's bundled Bun (Hutch 0.27.1 downloaded Bun 1.4.0 in the Mac handoff).
Use a checkout of this branch that includes `spikes/mobile`: the companion reuses that spike's owner transport and
Goblin's canonical Pi projection. Install the repository dependencies as well as the isolated desktop dependencies.

If this worktree is still only on the build box, create a tracked handoff there:

```sh
git archive --format=tar.gz --prefix=goblin-desktop-mvp/ -o /tmp/goblin-desktop-mvp.tar.gz HEAD
```

On the Mac, pull the archive from the build box, unpack it in an empty directory, and run the commands below from the
extracted repository. Replace `YOUR_BUILD_BOX` with the SSH host or tailnet name you normally use for this machine:

```sh
scp YOUR_BUILD_BOX:/tmp/goblin-desktop-mvp.tar.gz ~/Downloads/
mkdir -p ~/goblin-desktop-mvp
tar -xzf ~/Downloads/goblin-desktop-mvp.tar.gz -C ~/goblin-desktop-mvp --strip-components=1
cd ~/goblin-desktop-mvp
```

The archive contains source and lockfiles, not `node_modules`, Rust targets, credentials, runtime capability files, or
build artifacts.

From the repository root:

```sh
bun install --frozen-lockfile
cd spikes/desktop
bun install --frozen-lockfile
bun run build
bun run serve
```

Leave that terminal open. In another terminal, from `spikes/desktop`:

```sh
bun run launch gpui
# Or, in separate terminals:
bun run launch tauri
bun run launch electrobun
```

`bun run compare` opens all three; arrange their windows beside one another. The first native launches compile/download dependencies. Each window uses its own fixture conversation state.
`bun run launch browser` prints a local URL for the same web renderer. That URL contains a temporary local capability;
keep it private. The capability file is ignored, mode 0600, and replaced whenever the companion starts.

These commands open development windows. They do not produce a signed, notarized, self-contained macOS installer.
Keep the companion running. Close the windows and press Ctrl+C in its terminal when finished.

## Remote server versus Mac

macOS windows, Metal rendering and VoiceOver must be tested on macOS. Copy or fetch this branch to the Mac and run
all three clients and the companion there for a fair comparison. Browser-only review can use an SSH local forward of
port 4173 to the server; open the loopback URL printed by the server's launcher on your Mac. There is no need to expose
an HTTP port publicly. Native mobile simulators remain part of the separate One spike.

## What to compare

Use the same 1180 × 820 window size and the same fixture in every client:

1. Send a message and select text while its answer grows.
2. Stop halfway through; verify the partial answer stays.
3. Add the 200-message stress history, scroll up, and send another message. Reading position should stay put.
4. Switch conversations during a reply, then return. Old chunks must not enter the selected conversation.
5. Reconnect, resize, use keyboard navigation, copy text, and check non-ASCII input.
6. On Mac, run VoiceOver, test IME composition, background/resume and native window controls.

Tauri and Electrobun use the exact same retained DOM client and system WebView. GPUI has a separate native Rust
implementation with retained `TextViewState` Markdown and the virtualized `MessageScroller`. The web list currently
retains all rows; this is a deliberate implementation difference to measure, not a toolkit performance result.
GPUI's composer is currently single-line. Web supports Shift+Enter. Web Markdown supports bold and inline code;
GPUI Kit supplies a fuller Markdown renderer. Neither spike executes MCP Apps, remote HTML or attachment workflows.

## Live dev mode

Fixture mode is the default and needs no account or external service. Live dev mode targets `https://dev.goblin.surf`;
set `GOBLIN_DESKTOP_ORIGIN` before starting the companion to use another allowed HTTPS or loopback development origin.

Choosing Live dev and pressing Send code sends a real email. After sign-in, Send calls the real primary Goblin
conversation and may incur normal model/tool costs. Live mode currently supports that conversation only.
The companion retains the signed Better Auth cookie in memory; renderers never receive it. Exiting the companion
forgets the session. This is not an OS keychain implementation. Uncertain submissions retry with the same operation
ID. A submission receipt means acceptance, not completed external work.

The live adapter reuses `spikes/mobile/src/api.ts` and `conversation.ts`, including current origin/CSRF checks,
validated submission receipts, the existing Pi projection, and fresh-snapshot reconnect. The repository install
supplies dependencies to those shared sources; the desktop install pins the shell and browser tooling separately.

## Architecture and boundaries

```text
GPUI (Rust / native GPU) ──┐
Tauri (system WebView) ────┼── loopback companion ── Goblin owner API (optional)
Electrobun (Bun/WebView) ──┘      fixture by default
```

The companion binds only to `127.0.0.1`, checks exact origins and a random capability, and exposes a fixed command
vocabulary. Each shell has an independent profile. Both web shells load the companion's local static UI; native
filesystem/shell plugins are not exposed to that UI. Electrobun uses its sandboxed WebView mode.

This shared companion keeps API behavior comparable and makes the MVP small. Production would need a lifecycle and
packaging decision: bundle it as a supervised sidecar, or move the transport into each native host. Include its
memory and CPU in every end-to-end measurement. The stream currently sends complete normalized view snapshots to
the clients; do not attribute the cost of that spike protocol to a toolkit.

## Validation

```sh
bun run typecheck
bun run test
bun run build
bun run test:browser
cargo test --locked -p goblin-gpui-spike
```

The browser test uses Playwright's installed Chromium; `PLAYWRIGHT_CHROMIUM` can select an existing executable.
Screenshots and private runtime files go to ignored `artifacts/`. See `evidence/` for observed results.
Bun tests cover real loopback HTTP and synthetic owner API behavior. They are not authenticated dev, production,
macOS or real-provider acceptance. GPUI's `#[gpui_kit::test]` exercises a headless test window; pixels and assistive
technology still need native review.

Linux compilation uses a disposable dependency image, not host package installation:

```sh
heavy docker build -t goblin-desktop-spike:20261014 -f spikes/desktop/scripts/Dockerfile.linux .
cd spikes/desktop
scripts/linux-build.sh build --locked -p goblin-gpui-spike -p goblin-tauri-spike
scripts/linux-build.sh test --locked -p goblin-gpui-spike
# With `bun run serve` running in another terminal:
scripts/linux-smoke.sh gpui       # or tauri / electrobun
```

`heavy` is specific to the shared build box. Exit 75 means capacity contention; retry the unchanged command.

## Measuring on Mac

Build once before timing anything. Use the same viewport, display scale and fixture. For idle and stress-history
measurements, run one shell at a time with a fresh companion. Use Activity Monitor to identify the native app and
companion PIDs, including WebView helper processes. A portable sampler is included:

```sh
python3 scripts/measure.py --pid APP_PID --companion-pid COMPANION_PID \
  --label tauri-idle --warmup 3 --seconds 20 --repeats 3 --output artifacts/tauri-idle.json
```

This records a deduplicated process-tree RSS sum, numeric process snapshots, cumulative CPU-time deltas (100% is one
logical core), and median/p95/peak summaries. Add repeatable `--helper-pid PID` options for verified reparented WebView
helpers; helper completeness is never inferred. Shared pages can still be double-counted across processes: RSS is not
macOS private footprint. Dead/reused roots invalidate totals; CPU intervals with process churn are recorded as null.
The repeated windows sample the same running processes, not independent launches. Sampling is bounded to one hour.
It does not time startup or measure frames. The script never records command lines, tokens or chat content and does
not stop any process. Use Instruments for Metal/frame timing and memory footprint, and state the metric reported.
Compare cold and warm launches separately; exclude compiler and package-download time.

## Automated benchmark commands

These probes require no Accessibility or Screen Recording permission. Native launches still need a logged-in Mac
desktop session (or Xvfb on Linux). Prebuild artifacts, then run the runner against an executable or `.app`, never a
dev compiler/watcher. From `spikes/desktop`, for a quick check using the existing development artifacts:

```sh
bun run build
cargo build --locked -p goblin-gpui-spike -p goblin-tauri-spike
bun run electrobun:build
python3 scripts/benchmark.py --shell gpui --app target/debug/goblin-gpui-spike \
  --build-label dev --scenario history --trials 3 --warmup-runs 1 --seconds 10 \
  --output artifacts/gpui-history.json
python3 scripts/benchmark.py --shell tauri --app target/debug/goblin-tauri-spike \
  --build-label dev --scenario history --trials 3 --warmup-runs 1 --seconds 10 \
  --output artifacts/tauri-history.json
```

For Electrobun, pass `--shell electrobun --app PATH_TO_BUILT_APP` using the `.app` under `electrobun/build/` on Mac
or the bundle directory containing `bin/launcher` on Linux. The runner reads `CFBundleExecutable` from a Mac bundle;
`--cwd PATH` overrides its working-directory choice when needed. Run one shell at a time. Change `--scenario` to
`idle` for the four-message baseline. Each trial owns a new fixture companion and native process group, and cleans
up only those processes. It uses private temporary connection files; the manual `bun run serve` session is untouched.

The runner automatically opts into `GOBLIN_DESKTOP_BENCH=1`. Each host then emits exactly one content-free
`DESKTOP_READY` JSON line after its native window constructor returns (`stage: window_created`, shell, PID and schema
version). Logging is off by default. Spawn-to-ready includes pipe-observer delay and is **not** first paint, loaded
chat, input, or accessibility acceptance. Unrecognized host logs are discarded so capability-bearing URLs cannot
enter the receipts. Startup failures/timeouts remain failed trials and produce a nonzero exit status.

JSON receipts include every trial, warmup labels, startup median/p95/peak, process samples and CPU/RSS summaries,
executable/lockfile hashes, artifact and web-asset bytes, and fixture HTTP/SSE timings. SSE timings observe the
companion, not renderer updates; 204-message setup is service-verified. macOS helper attribution remains incomplete
unless separately checked with the sampler's `--helper-pid` options. Artifact inventory is shell-only: the companion
is not packaged, Tauri bundling is disabled, and a GPUI binary is not an app bundle. No installer-size claim follows.

Use a new output filename for each run; existing runner/browser reports are never overwritten. For comparisons,
build optimized artifacts first (`cargo build --release --locked ...` for Rust), label the actual build profile, and
keep dev/release results separate. Warmup runs are excluded from startup summaries. Cache state is uncontrolled;
repeated launches are not cold starts. Keep viewport/display/power conditions constant and retain failed trials.

For the shared DOM renderer alone:

```sh
bun run benchmark:browser -- --trials 3 --seconds 2 --output artifacts/browser-scroll.json
bun run test:bench
```

The browser benchmark uses headless Chromium and runs two fresh-fixture workloads per trial: 204 rows at rest,
and 206 rows after Send adds a user message and streamed reply. It records DOM counts, scroll range, raw animation
callback intervals, scroll-step JavaScript time, and long tasks when supported. The finite reply may finish during
the trial. These are programmatic-scroll/scheduling proxies, not native WebView, GPU frame-presentation or trackpad
measurements. It does not modify the existing 12-check `scripts/browser.ts` acceptance suite. `bun run check` also
runs the Python sampler/runner regression tests.

GPUI virtualizes row drawing while retaining Markdown state for all messages; the web client retains DOM rows.
The companion sends full normalized snapshots, including history, on every update. These implementation costs
remain part of the workload and must not be attributed to a toolkit without separate measurement.
