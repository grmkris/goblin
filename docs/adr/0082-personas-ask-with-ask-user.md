# ADR 0082: A tagged Persona asks with ask_user

Status: Accepted. Supersedes the `ask_user` item of ADR 0033's tools a Persona never has; the rest of 0033 stands.

A Persona answers in a background fork of the chat it was tagged in (ADR 0033), and `ask_user` was kept from it: a
Persona that needed a decision before it could go on (the size of a cover, one of two directions) said so in prose. A
server that relays a chat to someone else (ADR 0081) cannot draw prose as choices, and the owner had nothing structured
to answer.

## Decision

- **A tagged Persona may ask.** Its fork keeps `ask_user`, which ends the fork's run as it ends goblin's
  (`terminate`). The answer is written back as before, and its `app.persona` data carries `questions`, the
  `QuestionSpec`s it asked. An answer that only asks has empty words and still counts as an answer.
- **A tag answers.** The owner answers by tagging the Persona again. The new fork is cut at that message, so it reads
  its own questions and the answer. There is no resume of the old fork and no new endpoint: whoever may send to the
  chat may answer, an API key included (ADR 0081).
- **Text readers see the questions.** In the model's context, and wherever only text is shown (a Source's reply,
  retrieval), the answer is the Persona's words followed by its numbered questions (`personaAnswerText`).
- **Servers and the web see them as questions.** The entries read (`GET /api/conversations/:id/entries`) carries
  `questions` on the Persona's entry; the web shows them under the answer, with how to answer.
- **Routines still do not ask.** A routine's Persona run has no owner present to answer, so it says what it needs in
  its answer, as before.

## Consequences

- A Persona's fork prompt says to ask with `ask_user` and stop; a routine's says to say what it needs.
- A thread started with anchor `latest` from a chat a Persona answers in forks at that chat's newest settled entry and
  inherits the entries before it by reference. A reader that wants only the thread's own entries reads
  `entries?after=<forkEntry>`.
