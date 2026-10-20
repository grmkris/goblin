# ADR 0087: The owner's own subscription models

Status: Accepted.

The deployment's owner runs models on their own consumer subscriptions (Claude, ChatGPT/Codex, Grok) through CLIProxy,
reachable from the deployment's LiteLLM. Those subscriptions are personal: their terms do not allow serving other
people, and their quota also runs the owner's own tools. goblin offered every account the same models (`MODELS`), and a
server's key (ADR 0081) runs owner turns in the Topics it makes, on the owner's model pick. Offering these models to the
owner alone would still let a server's customers reach them through the owner's pick or a Persona's model.

## Decision

**The owner's models are offered to the owner alone.** `OWNER_USER_ID` names the deployment's owner and `OWNER_MODELS`
the models on their own subscriptions. `offeredEndpoint(env, userId)` offers them to that account after every account's
models, and to no other: another account's picker never lists them, its pick is refused, and a call naming one is
answered with a model it is offered (`Inference.served`). A name also in `MODELS` is everyone's.

**A server's work never runs on them.** Work is a server's when it comes through an API key, or when it runs in a Topic
a key made, whoever works there (`serverWorkIn`):

| Where | What it runs on |
| --- | --- |
| A turn in that work (`useModel`) | `Models.forServers`: the owner's pick, unless it is one of their own, then the default |
| A routine run there | the same |
| A Persona's turn there (`Personas.ownModel`) | its own model only when that is not one of the owner's own; else the chat's |
| A key reading the models (`agent.models`, `agent.model`) | `Models.choiceForServers`: without them |
| A key writing a Persona | refused (`invalid_input: persona_model`) when it names one |

The owner's own Topics, Personal, their Personas and routines may use them. The six known subscription models are in
`models.ts` on their own route (Your subscription): each calls tools and reads images, and none can switch thinking
off, so asking at no level asks for low (ADR 0083).

## Consequences

- The fence is a property of the Topic, so it holds for work that runs later, outside any request: a Persona's answer,
  a continuation, a routine firing.
- The owner typing in a Topic a server's key made gets the deployment's models there, not their own.
- `OWNER_USER_ID` is a private id: it lives in the stage's `.local` file and the CI secret, bound as a Worker secret,
  and never in committed text.
- Inbound OAuth clients act as the owner and are not fenced; only server keys are.
