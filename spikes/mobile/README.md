# Goblin mobile: One spike

An isolated React Native client using [One](https://onestack.dev/docs/introduction) 2.6.11, React Native 0.87.1 and React 19.2.3. This is a feasibility spike, not a replacement for the shipped web app. Its dependencies and Bun lockfile are separate from Goblin's production workspaces. React Navigation 8 peers are alpha releases.

## What works in the spike

- Email OTP sign-in with the existing Better Auth endpoints, optional invite code, session restoration and sign-out.
- Native session cookies held in One's Keychain/Keystore-backed `SecureStore`, scoped to the configured origin. The web preview uses the browser's HttpOnly cookie jar.
- `/c/1` personal conversation, plus `/c/<chat-id>` routes and the configured `goblin-spike://` native scheme.
- Snapshot, incremental Pi SSE, transcript, partial assistant text, completed tool status, queue count and Stop.
- Retry of an uncertain submission keeps the input and operation ID. Definite admission refusals allow editing again.
- Backgrounding cancels the stream; foregrounding and reconnect start from a fresh snapshot.

The client calls the existing owner HTTP API. No Worker, auth policy, database, model provider, permission, or production UI changes are required. Inbound MCP bearer tokens are not used for owner access.

## Reuse and tradeoffs

The spike directly imports Goblin's existing pure [Pi projection](../../apps/web/src/lib/projection.ts) and validates requests with [shared contracts](../../packages/contracts/src/index.ts). This keeps wire semantics aligned. A production mobile app should move that projection to an explicitly shared package.

Goblin's DOM/shadcn UI is not a native UI kit. This spike supplies small React Native screens instead. One supplies routing, native bundling, safe areas, streaming fetch and secure storage; it does not remove the work of building mobile screens.

Three integration details matter:

1. **Platform imports must be extensionless.** `./client.ts` selected the browser client even in a native bundle. `./client` selects `client.native.ts`; final native bundles must be inspected for the secure-store implementation.
2. **Effect must be a singleton.** The standalone spike and root workspace initially loaded separate instances, breaking shared schema validation despite matching versions. Vite and Vitest explicitly resolve the intended instance.
3. **Native redirects need a patch.** One 2.6.11's native fetch did not honor `redirect: 'error'`. The pinned [Bun patch](patches/one@2.6.11.patch) disables all redirects in its iOS and Android fetch implementations. This protects explicitly attached owner cookies and OTP request bodies. It is intentionally spike-wide; a production decision needs upstream support or a maintained transport. Native source compilation and redirect behavior on hardware are still unverified.

Native requests set the configured origin and the existing CSRF header, retain only Better Auth's signed owner-session cookie, omit the native cookie jar, and reject foreign API URLs. Storage writes are serialized so an in-flight renewal cannot restore the local session after sign-out.

## Run it

From the repository root:

```sh
bun install --frozen-lockfile
cd spikes/mobile
bun install --frozen-lockfile
heavy bun run check
heavy bun run test:local
```

`test:local` runs the existing local workerd owner stack with real D1 auth and PersonalAgent/Pi, captured fixture mail and a deterministic model. It does not send email or call a paid model. Its base port is 19021 in `vitest.local.config.ts`; change that test config if the port is occupied. It invokes the runtime workspace's Vitest so Alchemy and the test share one runner.

For the synthetic browser check:

```sh
heavy bun run build
heavy bun run test:browser
```

The browser script requires Playwright Chromium installed (`bunx playwright-core install chromium` if missing), serves the built SPA on an ephemeral loopback port, and shuts everything down after the test. It exercises the UI against synthetic endpoints, never a deployed Goblin account. Screenshot: `dist/proof/mobile-chat.png`. This proves browser behavior; it does not prove native keyboard, safe-area, secure-store or transport behavior.

For native development, create `.env.local` from [.env.example](.env.example), then:

```sh
heavy bun run build:android
heavy bun run build:ios
bun run prebuild:native --platform android --no-install
# With the required Android SDK/NDK and an emulator available:
heavy bun run android
# On macOS with Xcode and CocoaPods:
heavy bun run ios
```

`ONE_PUBLIC_GOBLIN_URL` defaults to the public dev origin and is embedded in the native bundle. Only put a public origin in this setting, never a secret. Sign-in and sends from a native app target that origin and are real actions. The browser client is always same-origin: plain `bun run dev` needs an API mounted at that origin; use the synthetic browser check for a self-contained preview.

One's build replaces `dist`, so run the web build again before browser acceptance after a native bundle build. `ios/`, `android/`, build output and generated route declarations stay untracked. `goblin-spike://c/1` is a configured custom scheme; a real OS launch has not been tested, and HTTPS universal/app links are not configured.

## Acceptance boundary

See [the dated receipt](evidence/2026-10-13.md) for commands and results. A JavaScript bundle is not an APK, IPA or device run.

The generated Android project requires compile SDK 37, build tools 37.0.0 and NDK 27.1.12297006. This build environment has SDK/build tools 35 and no NDK. iOS binaries require macOS/Xcode. Neither platform's native binary has been built or installed here.

Still missing: rich Markdown/code rendering, attachments, conversation discovery/history pagination, queue editing, embedded MCP Apps, push notifications, app-store packaging and production session lifecycle review. Native startup time, memory use, scroll performance, keyboard avoidance, secure-store persistence and background recovery need actual device measurements.

**Recommendation:** continue One as a candidate for a separate Goblin mobile client. First compile and run this exact spike on Android and iOS; verify cookie rotation, sign-out, redirects, split-token SSE and foreground reconnect against a disposable dev account. Keep the existing web app until that evidence supports a larger migration.
