# Interactive replies are ordinary owner follow-ups

Accepted. Extends the read-only drawn fences in ADR 0023 and the ordinary-message decisions in ADR 0067.

Goblin may render a complete `openui` fence as a small form, choice list or dashboard using its own UI components.
A click submits the button's visible text and visible field values through the containing conversation's existing
owner-message path. Generated code cannot supply a separate hidden instruction, tool call, URL action or grant.
There is no new interaction record, transcript, submission endpoint or execution engine: Pi keeps owning them.

This chooses a constrained in-process component interpreter over arbitrary generated HTML or another sandboxed
App. The grammar and schemas are bounded before rendering; functions, queries, mutations and hosted bundles are
rejected. Open/invalid fences and render failures remain readable code. The component library offers no network or
HTML primitives. Tool permissions and approvals continue to use the existing tools and cards.

Form edits are ephemeral and reset on reload. The submitted values are durable only as the next ordinary message;
unchanged failed sends reuse the normal operation identity. Quoted replies and closed chats have disabled controls.
The runtime describes the grammar in its static persona guidance and avoids these fences for external channels.
