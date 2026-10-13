# Goblin native toolkit research

Research date: 2026-10-13. Scope: public websites, GitHub source, release notes, package metadata, and selected issue reports. No toolkit was built, benchmarked, or run as part of this research.

## Recommendation

GPUI Kit is the strongest candidate from this survey for a dedicated, custom-rendered Goblin desktop client. It already supplies several unusually relevant pieces: streaming Markdown, a virtualized chat scroller, message composition, text editing, diffs, docking, and a documented interaction-test harness. Start a bounded macOS prototype against the released 0.7.3 with its default GPUI backend. Compare GPUI Fast later on the same workload.

This would be a separate client of Goblin's existing owner API. It is not a macOS renderer that can be added to One, and a Rust implementation does not directly reuse Goblin's TypeScript/Effect contracts or React components. Keep the One mobile experiment independent. GPUI Kit's own mobile documentation describes experimental embedding and explicitly keeps desktop as the primary target.

If one production UI across desktop and mobile is the overriding requirement, Flutter and Compose Multiplatform merit a separate evaluation. If preserving the existing web UI and MCP Apps integration is the overriding requirement, Tauri remains a practical comparison baseline; Electrobun is another current option particularly relevant to a Bun/TypeScript codebase.

## Verified identity and release state

- The old `longbridge/gpui-component` repository redirects to [longbridge/gpui-kit](https://github.com/longbridge/gpui-kit).
- The latest GitHub release and crates.io version observed were [0.7.3](https://github.com/longbridge/gpui-kit/releases/tag/v0.7.3), published 2026-10-12.
- Release commit: `67265a36e260ffe03c5aaebdcd8d654dbf892eab`.
- Inspected main commit: `c5f8eca4a0759f8c0c7ed624eddfd03f1c93a5f2`, dated 2026-10-13. Some main-branch WebView capabilities are ahead of the release.
- Software is Apache-2.0. GitHub's generic license metadata says `Other` because the repository also carries documentation terms; the source license was read directly. Documentation prose has separate CC BY 4.0 terms described in the README.
- Approximately 17.2k GitHub stars at the time of inspection; this is an interest/activity signal, not acceptance evidence.

## What the layers do

| Layer | Responsibility | Adoption implication |
| --- | --- | --- |
| GPUI | Rust application/window model, layout, text and GPU rendering; macOS uses Metal | Native executable with custom-drawn UI, rather than a collection of AppKit widgets |
| `gpui-base` | Reusable interaction behavior and state | Useful if Goblin owns its visual system |
| `gpui-component` | Styled controls and higher-level components | Fastest route to a polished prototype |
| `gpui-kit` | One application dependency aligning the above and default assets | Preferred starting dependency |
| `gpui-shell` | JavaScript composition/business logic in a Rust GPUI host | Interesting experimental route; not React, DOM, Node, or One compatibility |
| `gpui-fast` | Optional GPUI fork with incremental rendering, scroll caching and native composition | Experimental; test on the same workload before choosing it |

Sources: [Kit README](https://github.com/longbridge/gpui-kit), [GPUI README](https://github.com/zed-industries/zed/tree/main/crates/gpui), [GPUI Fast](https://github.com/longbridge/gpui-fast), [Shell README](https://github.com/longbridge/gpui-kit/tree/main/crates/shell).

## Why Kit fits Goblin

The component sources and examples go beyond a general promise of GPU rendering:

- [`MessageScroller`](https://github.com/longbridge/gpui-kit/blob/v0.7.3/crates/component/src/message_scroller.rs) retains virtual-list state, follows the tail, supports jumping to the latest row, and preserves a scroll anchor when older messages are prepended.
- [`Message`](https://github.com/longbridge/gpui-kit/blob/main/crates/component/src/message.rs) has slots for avatar, header, content and footer. There are also bubbles and attachment controls.
- [`TextView`](https://gpui-kit.com/component/text-view/) supports Markdown/HTML document rendering, selection and code highlighting. The [streaming Markdown example](https://github.com/longbridge/gpui-kit/tree/main/examples/stream-markdown) updates retained document state in chunks.
- Release 0.7.1 specifically improved incremental Markdown updates and background parse handling during streaming. Release 0.7.3 adds a virtualized diff viewer and reduces redundant state writes that cause long scrolling views to rebuild.
- Tables, charts, docking, command palettes and editors are relevant to a desktop agent workspace containing tool output and code alongside conversation.
- The maintainers identify Longbridge Pro as a shipped application using the toolkit. That supports the desktop-use case but does not establish Goblin's performance or compatibility.

The advertised 120 FPS and GPUI Fast's published CPU-per-frame improvements are upstream claims/workload measurements. No Goblin measurements were made. Startup, heap, idle CPU, battery impact, long-history scrolling, selection and streamed Markdown all need measurement on the target Mac.

## JavaScript shell: promising, but not a drop-in path

The [Shell README](https://github.com/longbridge/gpui-kit/blob/main/crates/shell/README.md) explicitly calls it milestone M0 and an unstable feasibility baseline. JavaScript describes GPUI elements using Kit's own APIs; Rust performs layout, input, text editing and rendering. It provides generated TypeScript declarations, reload tooling, and explicit capabilities for host access.

The inspected [fetch implementation](https://github.com/longbridge/gpui-kit/blob/c5f8eca4a0759f8c0c7ed624eddfd03f1c93a5f2/crates/shell/src/engine/quickjs/standard/fetch.rs) establishes a concrete incompatibility with Goblin's current client:

- It reads the response body to completion before returning it.
- It uses a 30-second request timeout and an 8 MiB response limit.
- Its response exposes `status`, `ok`, `url`, `text()` and `json()`; it does not expose a streaming `body` or response headers.
- Request options are a smaller surface than browser fetch; unsupported options are rejected.

Goblin's current client consumes incremental SSE, cancels requests, examines headers for cookie renewal, and explicitly rejects redirects. It cannot simply be bundled unchanged into this runtime. A Rust host module could own HTTP/SSE, cancellation and secure session storage and expose typed events to JavaScript. Reusing pure JavaScript projection logic would still need a separate runtime/packaging compatibility test. JavaScript availability alone does not prove Effect, Web APIs or React compatibility.

For a first desktop spike, using Rust directly avoids introducing both an experimental UI host and a transport bridge at once. Shell is worth a second, deliberately bounded experiment if sharing JavaScript business logic is a major objective.

## Mobile and web scope

The current [mobile guide](https://gpui-kit.com/docs/mobile/) says desktop remains the primary target. It documents a community-derived mobile backend and a Swift-hosted iOS example. It reports limited iOS/Android validation of an AI chat area including TextView, inputs, menus, scrolling and selection. It does not claim full application or component coverage.

The described architecture embeds a GPUI view inside a native screen; UIKit/Android handles surrounding navigation, safe areas and keyboard layout. The current iOS bridge has a single application-lifetime view rather than independently destroyable, reusable instances. These are useful capabilities to investigate, but they do not put Kit on equal footing with a full mobile application framework.

Kit also has WebAssembly examples. A Wasm-rendered UI is a different output model from Goblin's existing DOM application and from One's React Native Web renderer. Do not assume identical browser accessibility, embedding or deployment behavior.

## MCP Apps and WebView boundary

Native Markdown or limited HTML document rendering cannot execute an MCP App. Goblin's sandboxed, interactive HTML apps need a real browser surface and the existing authorization/message boundary.

The [released 0.7.3 WebView README](https://github.com/longbridge/gpui-kit/blob/v0.7.3/crates/webview/README.md) calls its Wry integration experimental, lists macOS and Windows, and warns that the WebView covers overlapping GPUI elements.

The [inspected main README](https://github.com/longbridge/gpui-kit/blob/c5f8eca4a0759f8c0c7ed624eddfd03f1c93a5f2/crates/webview/README.md) is newer: it uses GPUI Fast, supports overlays above WKWebView on macOS and WebKitGTK on X11/XWayland, and still documents Windows overlay and native Wayland limits. Those improvements must not be attributed to the released tag. None proves Goblin's nested opaque-frame sandbox or MCP bridge works in that host.

A sensible experiment is native chat and desktop chrome, with a separately tested WebView panel for MCP Apps. Keep current authorization and isolation semantics intact.

## Testing and known issues

The [testing guide](https://gpui-kit.com/docs/test/) documents ordinary Rust unit tests, `#[gpui_kit::test]` entity/task tests, and headless production-view interaction tests that drive pointer, keyboard and scroll events and assert state, focus, geometry and callbacks. The [consumer recipes](https://github.com/longbridge/gpui-kit/tree/main/examples/ai_recipes) include an input-state/subscription regression example.

Pixel rendering is a separate test path. The current pinned headless renderer is macOS/Metal-only and is explicitly selected in macOS CI. Portable interaction tests are not proof of native IME, clipboard, VoiceOver or packaged-app behavior.

Relevant open reports found during research:

- [#3437](https://github.com/longbridge/gpui-kit/issues/3437): native macOS accessibility tree omits TextView body, reported against 0.7.1. It remained open with no comments at inspection time. Treat this as an acceptance case to reproduce against 0.7.3, not proof the new version fails.
- [#3295](https://github.com/longbridge/gpui-kit/issues/3295): revealing a range inside a tall virtualized TextView can produce duplicate accessibility nodes, reported against Kit 0.7.0/GPUI snapshot 0.3.7. Again, the current version requires verification.

The [packaging guide](https://gpui-kit.com/docs/packaging/) covers app bundles and distribution, but the application owns identity, assets, signing, notarization, installer and release testing. A Linux build does not create a tested macOS binary. macOS compilation, Metal checks and native acceptance should run on the Mac or a macOS runner.

## Other contemporary options inspected

These are fit judgments, not measured performance rankings. Versions are those observed on public release pages on the research date where stated.

| Toolkit | Rendering / authoring | Goblin assessment |
| --- | --- | --- |
| [Iced 0.14](https://github.com/iced-rs/iced) | Rust, Elm-style state/update/view, wgpu with software fallback | Credible alternative for a native Rust chat application; more of the polished chat/workspace composition would be app work |
| [Slint 1.18.1](https://github.com/slint-ui/slint) | Declarative `.slint`, Rust/C++/JS/Python logic, custom renderers | Strong UI tooling and broad deployment ambitions; different authoring model and license options, less direct reuse of Goblin's existing rich web UI |
| [egui 0.36.2](https://github.com/emilk/egui) | Rust immediate-mode, native and web | Strong for inspectors, tools and diagnostics; a polished chat product would need a different composition/style investment |
| [Dioxus / Blitz](https://github.com/DioxusLabs/blitz) | Rust reactive UI; Blitz renders HTML/CSS without a full browser | Interesting middle ground; Dioxus labels native rendering experimental and Blitz calls itself beta with missing features. It does not run arbitrary React code or supply a full browser for MCP Apps |
| [Makepad](https://github.com/makepad/makepad) | Rust, custom GPU UI and live-editable UI DSL; desktop/mobile/web tooling | Worth a deeper spike if a Rust UI across desktop and mobile is the goal; larger change to Goblin's authoring/tooling model |
| [Floem](https://github.com/lapce/floem) / [Xilem](https://github.com/linebender/xilem) | Reactive Rust GUI and modern rendering stack | Technically interesting; their own maturity statements are pre-1.0/experimental. Lower priority than Kit's chat components for this task |
| [Flutter](https://docs.flutter.dev/reference/supported-platforms) / [Compose Multiplatform](https://github.com/JetBrains/compose-multiplatform) | Dart / Kotlin, shared custom-rendered UI across desktop and mobile | More established choices when shipping one mobile+desktop UI matters most; require substantial client rewrite. Flutter's current docs describe 3.47; Compose latest non-prerelease observed was 1.12.1 |
| [React Native macOS](https://github.com/microsoft/react-native-macos) | React/JS with native platform integration | Highest potential reuse of One spike code among native Mac options; requires its own platform project and dependency compatibility work rather than an unsupported One target |
| [SwiftUI](https://developer.apple.com/xcode/swiftui/) | Swift and Apple-native UI framework | Strong Apple-first option with macOS/iOS integration; separate from Android and existing TypeScript UI |
| [Tauri 2.12.3](https://github.com/tauri-apps/tauri) | Existing web frontend in OS WebView, Rust host | Practical baseline for retaining Goblin's UI and browser-based apps; it does not replace the frontend with GPUI-style drawing |
| [Electrobun](https://github.com/blackboardsh/electrobun) | Bun/TypeScript host, system WebView or optional Chromium; optional native wgpu surfaces | Particularly relevant to the existing Bun toolchain. Its GPU surface support does not automatically turn React controls into native GPUI-like controls |

## Proposed next experiment

1. Pin released Kit 0.7.3 and commit the dependency lockfile in an isolated desktop spike.
2. Build a native Mac window with a conversation sidebar, composer, MessageScroller and streaming TextView using recorded/synthetic data first.
3. Connect a Rust owner transport to the existing API: OTP, secure cookie storage and rotation, cancellation, SSE snapshot/reconnect, stable send operation IDs, Stop and sign-out. Keep existing server authorization semantics.
4. Add one representative tool-result/diff view and investigate a sandboxed MCP App WebView separately.
5. Run portable tests on Linux; compile/run the actual app on the Mac. Exercise keyboard navigation, IME, copy/paste, links, VoiceOver, sleep/reconnect and long-history scrolling.
6. Measure release-build startup, memory, idle CPU, frame times and streaming behavior. Compare the default GPUI backend with Fast, and with an existing web baseline on the same data and hardware.

The acceptance decision should distinguish desktop feasibility, protocol correctness, MCP App compatibility, accessibility, measured performance and mobile scope. No app migration or toolkit benchmark has been completed by this research.
