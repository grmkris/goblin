# 0062: Short, skippable Start

Accepted 2026-10-14 with the owner. Supersedes ADR 0048 (first-run Start). Part of the cleanup that makes goblin an
open-source client anyone can deploy (ADRs 0056 to 0061).

## Context

ADR 0048's Start stood before the chats until the Goblin Wallet was set up and funded, featured Mercator, and allowed a
first-class server's recommended tools as it connected. The wallet and payments have left goblin (ADRs 0056 to 0058),
owners can bring their own model endpoint (ADR 0059), and any server's access is suggested from its tool annotations
and applied only by the owner (ADR 0060). A Start built on the wallet has nothing left to wait for, and a client anyone
can deploy should open on its chat: Start is help, not a lock.

## Decision

- **Four steps, every one optional.** `/start/<step>` is a full-screen page with one task per screen:
  1. welcome: what goblin is (the owner's agent, the model it thinks with, and the services it reaches through MCP
     servers the owner connects and allows);
  2. model: the deployment's models unless the owner brings their own OpenAI-compatible endpoint and key, in Settings'
     own form;
  3. services: the shelf (ADR 0061); the server just connected from here offers Use suggested access;
  4. goblin: what the owner wants goblin for, sent as the kickoff.

  The owner can pass any step by, or skip Start.
- **Never a gate.** No page waits for Start, whatever its status: the app is drawn the same for an open, skipped or
  finished Start. An owner who signs in through Create an account lands on the welcome. Otherwise Start is reached
  from a quiet row in the chat (while Start is not finished and the model or services step is left), Settings' card
  and Activity's checklist.
- **Done only by what the owner did.** `app_onboarding` keeps the status the owner set (`done` or `skipped`; `open`
  until then, and again after they reopen it) and the steps they went through. A step is done once the owner went
  through it; the model step also once they set their own endpoint, the goblin step once the kickoff was sent. Nothing
  is read from a server or derived from a wallet, and nothing marks Start done by itself. `GET /api/onboarding` answers
  from the agent alone; the gate's `GET /api/onboarding/status` is gone.
- **A sign-in Start begins comes back to Start, and allows nothing.** `POST /api/onboarding/connect` notes the step
  against the connection (`app_onboarding_connects`, an hour), and the OAuth callback takes the note and redirects to
  `/start/<step>` instead of Connections. No tool is allowed on the way: the step offers the server's suggested access,
  applied only when the owner taps it. Every connection registers with its authorization server as plain `goblin`.
- **The agent hears about setup only after the kickoff.** The kickoff is recorded before its message is sent. For twenty
  minutes after it, main's context block asks the agent to propose Topics and Personas in one `ask_user` question and
  to create only the ones the owner chooses. No other setup line reaches the model.

## Consequences

- An owner who never opens Start uses goblin on the deployment's models with nothing connected; the chat's setup row
  says how much is left until they finish or put it away.
- A row or connect note written by ADR 0048's Start keeps working: a step id it no longer has (`wallet`) is dropped when
  read, and a note for one comes back to Connections. `app_onboarding_connects.recommend` is written as 0 and never read
  until the migrations are squashed.
- The model step is always shown, also where the deployment's endpoint is all an owner needs. Asking for a key only
  when the deployment has none belongs to the config-driven deployment that follows.
