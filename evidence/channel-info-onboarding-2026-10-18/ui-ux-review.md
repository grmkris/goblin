# Channel info and onboarding UI/UX review

Mode: **full**. Reviewed application source: `7ea1d09b`, including the UI polish in `f26a2206` and current `dev` at `1de50c1d`.

Scope: Channel Info's Overview, Tools & skills, Shared and Work tabs; the goal, model, services and first-conversation onboarding steps; desktop side-panel and phone layouts; focus, disclosure, loading, empty states and setup navigation. The transcript renderer, connection permission editor and runtime authority model are outside this polish pass.

Framework and conventions: React with TanStack Start/Router/Query, locally owned shadcn/Base UI primitives, Lucide icons, Tailwind 4 and the existing plain CSS `app` layer. Changes use the current semantic tokens and system typography. No new styling or motion library.

Applied guidance: [frontend-design](../../.agents/skills/frontend-design/SKILL.md), [apple-design](../../.agents/skills/apple-design/SKILL.md), and [make-interfaces-feel-better](../../.agents/skills/make-interfaces-feel-better/SKILL.md).

The design keeps Goblin's moss rail as the distinctive surface. Content stays left aligned, with a small spacing rhythm, quiet secondary controls and one dominant next action. Desktop keeps conversation and channel context together; phone setup reserves a separate area for navigation. Existing descriptions, sign-in requirements, tool grants and Ask first remain visible where they inform decisions.

## Coverage

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Channel panel and onboarding screenshots at 390px, 820px, 1280px and 1440px; `steps.tsx`, `channel-info.css`, `start.css` | Shortened repeated copy and goal suggestions; existing type scale retained |
| Surfaces | Overview, collapsed/expanded capabilities, shared-item rows, service preview/catalog, keyboard-focused last service | Fewer separators and card surfaces; content-sized secondary actions; independent mobile scroll area |
| Animations | Disclosure chevrons, suggestion press styles, existing panel/setup transitions and reduced-motion rules | Small explicit transitions; new motion restricted to no-preference; state cues also work without movement |
| Icons | Info/Back/Close, capability chevrons, refresh and shared-item icons at rendered sizes | Existing Lucide set; decorative icons hidden; refresh keeps an accessible name and 44px target |
| Performance | Source diff, transition properties, mobile layout and full build | CSS handles layout; no new dependency, custom scroll listener, font or request. No performance benchmark claimed |

## Findings resolved

Spacing, hierarchy and progressive disclosure:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | [channel-info.css:103](../../apps/web/src/channel-info.css#L103), [channel-info.css:141](../../apps/web/src/channel-info.css#L141) | Section padding, grid gaps and row borders stacked repeatedly | Parent owns spacing; one divider between section groups and between adjacent work rows | Grouping is easier to scan when every row does not compete for a boundary |
| LOW | [channel-info.css:37](../../apps/web/src/channel-info.css#L37), [channel-tools.tsx:49](../../apps/web/src/components/shell/channel-tools.tsx#L49) | Full-width Edit/Choose/Load more actions and dense detail spacing | Content-sized secondary actions with 44px height; 16px detail gaps; shorter tool introduction | Secondary controls stop competing with the content and preserve clear touch targets |
| MEDIUM | [channel-tools.tsx:107](../../apps/web/src/components/shell/channel-tools.tsx#L107), [channel-tools.tsx:204](../../apps/web/src/components/shell/channel-tools.tsx#L204), [channel-info.css:154](../../apps/web/src/channel-info.css#L154) | Connection disclosure looked like static text; skill libraries opened all details immediately | Chevron, name and status/count lead; skills expand on demand with native keyboard behavior | Makes the action predictable and keeps long capability lists manageable |
| MEDIUM | [channel-shared.tsx:34](../../apps/web/src/components/shell/channel-shared.tsx#L34), [channel-shared.tsx:84](../../apps/web/src/components/shell/channel-shared.tsx#L84) | Refresh occupied a separate row; explanation wrapped across several lines | Search and labelled refresh icon share a row; shorter scope copy; filter controls have 44px targets | Gets shared content higher on the screen without hiding refresh or loaded-search scope |
| LOW | [steps.tsx:66](../../apps/web/src/components/start/steps.tsx#L66), [start.css:365](../../apps/web/src/start.css#L365) | Full-sentence suggestion pills repeated the goal and lacked a dedicated focus style | Short labels fill the same complete goals; real 44px targets, visible focus, pointer-aware hover and restrained press feedback | Optional suggestions are easier to scan and operate; Continue keeps priority |
| MEDIUM | [start.css:526](../../apps/web/src/start.css#L526) | Expanded phone catalog was a tall stack of padded card surfaces | Aligned list rows with lighter spacing and structural separators | Reduces visual clutter while retaining descriptions and sign-in requirements |

Positioning and navigation:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | [start.tsx:273](../../apps/web/src/components/start/start.tsx#L273), [start.css:428](../../apps/web/src/start.css#L428), [start.css:498](../../apps/web/src/start.css#L498) | Sticky Back/Continue could paint over service content | Content scrolls between the progress header and a separate navigation footer, with safe-area padding | Keeps the primary action reachable and prevents focused content from being obscured |
| MEDIUM | [router.tsx:24](../../apps/web/src/router.tsx#L24), [ui-start.ts:109](../../apps/web/test/ui-start.ts#L109) | The new inner scroller could carry an old offset into the next setup step | Registered `.start-content` with the router's top-reset selectors and tested scrolled Continue/Back transitions | Independent review caught this regression; the next task now opens at its heading and first field |

## Considered and rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Channel panel and setup | New typeface, glass surfaces or more shadows | Goblin already has a recognizable moss/system-font identity; extra materials add clutter |
| Service catalog | Truncate all descriptions to two lines | The service's purpose helps the owner decide whether to connect it; readable rows keep that context |
| Channel capabilities | Replace disclosures with a dense row of icons or badges | Names, readiness and skill counts communicate more clearly; the existing permission semantics remain legible |
| Entire flow | Add spring entrances and animated tab changes | Frequent task switching benefits from immediate feedback; small state transitions suffice |

## Verification

- `bun run check:files apps/web/src/channel-info.css apps/web/src/start.css apps/web/src/components/shell/channel-tools.tsx apps/web/src/components/shell/channel-shared.tsx apps/web/src/components/start/steps.tsx apps/web/src/components/start/start.tsx apps/web/test/ui-channel.ts apps/web/test/ui-start.ts` — passed during iteration.
- `heavy --wait=3600 bun run check:fast` — passed after the scroll-reset fix.
- `heavy --wait=3600 bun apps/web/test/ui-channel.ts` — passed on `7ea1d09b`: 1440×900 and 390×844, collapsed/expanded skills, shared history, draft retention, focus return, thread return and no horizontal overflow.
- `heavy --wait=3600 bun apps/web/test/ui-start.ts` — passed on `7ea1d09b`: 390px/820px/1280px, light/dark setup screens, service preview/catalog, last-service keyboard visibility, navigation non-overlap, 390×500 scrolled Continue/Back, retained drafts and retry-safe channel kickoff.
- Independent code review — no actionable blockers at `7ea1d09b`, after resolving the scroll-restoration finding.
- Full repository gate: passed on `7ea1d09b`; browser interaction review covered slowed disclosure at 10% playback, hover, keyboard focus, loading/refresh, empty search, filter changes and Work/Overview navigation.

The screenshots render real components with synthetic API data. The chat reconnect banner is fixture state. The three original-flow composites compare `68e898b6` with `7ea1d09b`; the Tools, Shared and Services polish comparisons use the prior PR state `c04a1284`. Services uses a viewport crop of the earlier full-page capture. Raw browser captures remain outside source control.

Not verified: real iPhone/iPad Safari, the actual software keyboard, screen-reader sessions and deployed authenticated acceptance. Performance review is source/build inspection, not a benchmark.

Verdict: **Approve** for the reviewed UI/UX scope. Real Safari, touch keyboard, screen-reader sessions and deployed acceptance remain unverified as stated above.
