# ADR 0100: A Persona thinks at its own level

Status: Accepted 2026-10-22 with the owner. Amends ADR 0033 (a Persona's definition) and ADR 0083 (conversations
think at medium).

ADR 0083 bounded thinking by each model's own control and had every conversation think at medium: on Qwen 3.8 a
thinking budget of 8,192 tokens. A Persona's fork is a conversation, so it thinks at medium too. A server that runs
long jobs through a Persona (a logo set planned, drawn and checked in one answer) wants more room on the hard step,
and a Persona that only triages wants less; neither could ask for it.

## Decision

- **A Persona names how hard it thinks.** Its definition gains `thinking`, `low`, `medium` or `high`, optional
  (`PersonaThinking`). It is stored on the Persona and on each revision (an additive migration on `app_personas` and
  `app_persona_revisions`), so an invocation thinks at the level of the revision it froze. Without one it thinks at
  medium, as before.
- **Its fork thinks there.** The turn's fork phase sets the fork's `thinkingLevel` in the commit that makes it, as it
  sets the Persona's model; a routine's run handed to a Persona (ADR 0041) is configured the same way. The level goes
  through ADR 0083's controls unchanged: on Qwen, pi-ai's budgets, 2,048 at low, 8,192 at medium and 16,384 at high;
  on the effort models, their effort for that level. The output limit stays the ceiling.
- **Create, update and read carry it.** `POST /api/personas`, `PATCH /api/personas/:id` (`thinking: null` returns it to
  medium) and `GET /api/personas/:id` carry it, and so do the list's summaries, the revisions and `/mcp`'s
  `persona_create`, `persona_update`, `persona_get` and `persona_list`, which take their shapes from those endpoints.
  An organize Undo restores it with the rest of the definition.

## Consequences

- A server sets a Persona's thinking the way it sets its model, per Persona and revision.
- `high` costs up to twice medium's thinking tokens on every step of that Persona's answers, and more time.
- The profile page does not show it yet; a save there keeps the level the Persona has.
- `xhigh` and `max` are not offered: Qwen and pi-ai's budgets stop at high, and an effort model's max is rarely worth
  its time for a Persona.
