# Goblin desktop comparison

Three desktop clients for the same chat experiment: GPUI Kit 0.7.3, Tauri 2.12.3, and Electrobun 2.0.2
(Hutch 0.27.1). This is an isolated spike, not a change to Goblin's shipped web or mobile clients.

## Run on your Mac

Install Xcode command line tools (`xcode-select --install`), Rust stable, Bun 1.4.2 or newer, and Node 22 or newer.
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
  --label tauri-idle --seconds 20 --output artifacts/tauri-idle.json
```

This records a process-tree RSS sum, which can double-count shared pages; it is not macOS private footprint. It does
not time startup or measure frames. The script never records command lines, tokens or chat content and does not stop
any process. Use Instruments for Metal/frame timing and memory footprint, and state exactly which metric is reported.
Compare cold and warm launches separately; exclude compiler and package-download time.
