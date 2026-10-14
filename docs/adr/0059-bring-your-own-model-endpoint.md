# 0059: Bring your own model endpoint

Accepted 2026-10-14 with the owner. Amends ADR 0002 (the deployment's model plane) and the root instructions' provider
rules. Part of the cleanup that makes goblin an open-source client anyone can deploy (ADRs 0056, 0057, 0058).

## Context

Every model call went to the deployment's one endpoint (Railway LiteLLM for goblin's own stages) with its one key, so the
deployment paid for every account's tokens and chose every account's models. goblin is to be a client anyone can deploy
and anyone can use with the model they already pay for, and a hosted deployment that charges does so by selling model
keys outside goblin's code (ADR 0058).

## Decision

- **An owner may bring their own endpoint.** Settings takes an OpenAI-compatible base URL (`https://…/v1`) and a key.
  goblin checks the URL as it checks a server the owner adds (public https, no user name, password or fragment) and
  lists the endpoint's models (`GET <base>/models`, the key as a bearer token, no redirects, ten seconds, at most 500
  ids); an endpoint that refuses the key, cannot be reached or lists no models is refused with the reason. The endpoint
  is one row in the agent's SQLite (`app_model_endpoint`), the key sealed with the credential cipher and bound to the
  agent, and the list of models kept with it.
- **The owner's endpoint wins.** Without one, calls go to the deployment's endpoint (`GOBLIN_MODEL_BASE_URL`,
  `GOBLIN_MODEL_KEY`) and its models (`GOBLIN_MODEL_ID`, `GOBLIN_MODELS`). Removing the owner's endpoint goes back to
  the deployment's.
- **Each call is resolved when it is made.** One Pi provider serves every model id; each request asks `Inference.served`
  for the endpoint, the key and a model it serves: the one asked for when the endpoint lists it, else the endpoint's
  first. Turns, threads, subagents, Personas, routine runs, housekeeping (the memory model) and an app's `llm` power all
  go through it, so a model id stored before a switch still answers. A call whose endpoint cannot be read ends as a
  failed response; nothing falls back to the other endpoint.
- **The picker offers the endpoint's models.** The owner picks among the models the endpoint in use lists; a pick it
  does not list falls back to its first.
- **The deployment's cap holds for the deployment's endpoint only.** Tokens are counted either way; on the owner's own
  endpoint nothing is refused for them (`limit` is null).
- **The key is never shown again.** The owner API answers the endpoint's base URL, its models and the key's last four
  characters (none of a key shorter than 16); the key reaches no log, transcript, telemetry or browser.

## Consequences

- A deployment still needs its own endpoint and key today; making them optional, with Start asking for a key when the
  deployment has none, is part of the config-driven deployment that follows.
- The list of models is read when the endpoint is set. A model the endpoint adds later appears when the owner saves it
  again; one it drops answers as the endpoint's first.
- Model labels and image support come from goblin's hint table by id; an unknown model is offered under its own name,
  text only.
