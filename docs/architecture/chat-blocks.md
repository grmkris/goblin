# Chat blocks

## Chat blocks

The agent's replies draw fenced blocks (ADR 0023): ```mermaid diagrams, and ```chart and ```map with a
JSON spec (`ChartSpec`, `MapSpec` in `packages/kit/src/specs.ts`). `MessageText`
(`components/parts/text-part.tsx`) hands such a block to `RichBlock` (`components/parts/blocks.tsx`), which loads that kind's module from `@goblin/kit`
on first use and shows the plain code block whenever the source does not parse or drawing fails. While a reply
streams, the block whose fence is still open stays code: Streamdown parses each block on its own and says which one
that is (`useIsCodeFenceIncomplete`). A diagram is drawn inline by Pele (ADR 0129), any Mermaid kind, laid out
for its column's width and loading only its kind's renderer. Every drawing passes `diagram-svg.ts`, which rebuilds it
in a detached tree from Pele's passive vocabulary: shapes, text, Pele's classes and variables and its `data-id`s; ids,
links, scripts, handlers, styles, URLs and a diagram's own classes never reach the page. goblin fixes Pele's options
(`diagram-render.ts`: no links, no images, bounded source and edges). `kit.css` maps the theme's tokens to Pele's
`--pele-*` variables, so light and dark follow the page without a redraw. **Explore diagram** draws the same source at
its natural size in the kit's native dialog, with Panzoom 4.6.2, fitted 1–4× zoom, bounded dragging/pinch gestures and
keyboard node selection; a graph kind's neighbours come from Pele's parsed model (`diagram-graph.ts`), and other kinds
zoom and pan without selectable nodes. `Diagram` defaults to interactive; `interactive={false}` draws without the
explorer. The dialog stays inside an agent app's frame. Charts are Pele's drawings too (ADR 0130): `chartSource` writes the spec
as a Mermaid `xychart` (bars or lines, named series, the unit on the value axis) or `pie`, drawn through the same
allowlist, each series in the next `--chart-*` token; there are no area or stacked charts and no hover values. Maps are
Leaflet itself, driven by the kit's `MapView` (no react-leaflet), over OpenStreetMap's raster tiles, quieted to the
theme by a CSS filter, the one host a block fetches from; a label reaches a tooltip as text, never HTML. The persona prefers ordinary Markdown and describes the supported fence grammars; text-only external message tools receive the fenced text.

## Interactive replies

A complete `openui` fence uses OpenUI Lang 1.0.1 with Goblin's allowlisted component library
(`apps/web/src/components/parts/openui/`). It is lazy-loaded through the same `RichBlock` path. The browser owns
only local field edits; Pi still owns the reply and every submitted message. Reloading restores the original form
values, while submitted values remain in the ordinary transcript. The runtime's static guidance is
`apps/runtime/src/pi/reply-ui.ts`; it introduces no renderer dependency into the Worker.

`syntax.ts` uses the pinned language parser to inspect expressions before reference expansion: at most 64 unique
statements, depth 32, and 2,000 expanded nodes. Only supported components, literals, arrays, objects and named/scalar
state references are accepted. The component Zod schemas bound their values and collections. `program.ts` also
bounds source to 20,000 characters and rejects incomplete programs, unresolved references and hosted bundles.
The Renderer never receives the reply's own text: `syntax.ts` prints the checked statements back, one per line with
JSON strings, and only that program is parsed and drawn. OpenUI strips comments and Markdown fences before it parses
and the tokenizer does not, so raw text could check as one program (`pad = #'` opening a string) and render as another.
Queries, mutations, executable actions and functions are unsupported. Parse, load and render failures retain the
code fallback; an open streaming fence stays code until it closes.

The root is a native form. Buttons have only a visible label, never a hidden instruction or executable action.
Model-written text that a click sends (button and field labels, options, text defaults) must be one line that shows
whole: no control, format (bidi, Unicode tag, zero-width), private or unassigned characters and no padding beyond
single plain spaces. Labels are at most 120 characters and reply buttons wrap; options and text defaults are at most
40 characters, so they fit their controls. Submission reads that label and `FormData` from the mounted visible
controls, checks it again (`message.ts`), and is bounded to 20 values and 12,000 characters. `ReplySend` points to the containing `ChatView`'s normal `useConversation.send`, so the typed owner API,
CSRF header, operation identity, queue and failure handling stay unchanged. While a submission is pending the form
is disabled, and focus then returns to where the owner sent from; a failed unchanged message retries with the
existing operation ID. Enter in a field submits only when the form has one button: with several, Enter would send
the first, a choice the owner never made, so they press the one they mean. A number field keeps what is typed and
the browser checks its range and that it is filled when the form is sent. Closed/archived chats, quoted
content and views without an owner submission context disable the form. A click authorizes no tool or grant
(ADR 0074).

The library composes local shadcn controls and the existing kit chart; it offers no raw HTML, image, link, script,
network provider or custom function. Renderer observability is disabled. The pinned dependency is patched to prevent
its automatic development inspector from mounting, with the installed patch verified by `check:patches`.

The public [reply playground](../../apps/openui-spike/README.md) imports `@goblin/web/replies`, the same renderer and
validation as chat, and records submissions locally against synthetic examples. It is not an authenticated agent
or a live model experiment. `apps/web/test/ui-openui.ts` exercises the actual send hook with intercepted owner HTTP
requests; the playground's browser check separately exercises built and deployed assets.
