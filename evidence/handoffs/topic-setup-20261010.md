# Topic setup and Persona setup: 2026-10-10

The owner settled the design in a grilling session on 2026-10-10, from the research handoff
`topic-persona-capabilities-20261010.md`. The approved plan is `~/.claude/plans/let-s-grill-me-to-fancy-catmull.md`
and the decision record is [ADR 0040](../../docs/adr/0040-topic-and-persona-setup.md). One session implemented it
directly on `main`, one commit per change.

## What it is

- **A Topic has a setup**: its MCP servers (each with all its tools or a list), skills (whole libraries or single
  skills by server + name), agent apps and whether its chats may start subagents. Each list category is `all` or a
  list. Every chat of the Topic works with it, read live: its Conversation, its threads, Telegram and connected
  clients in Personal. Every existing Topic started with everything.
- **A Persona has a setup too**: what it adds to the setup of the Topic it answers in (effective = Topic ∪ Persona).
  It is frozen with the Persona's revision when it is tagged; the Topic's side is live.
- **The per-conversation switches of ADR 0010 are gone**: the composer's switches popover, Reset, copy-on-create,
  "Turn on here" and the endpoints. Goblin's own exclusions for its subagents (`subagent_config`) stay.
- **Owner authority is unchanged and decides last**: grants, ask-first, skill-server opt-in, resident authority and
  plan are checked at dispatch, after the setup. A setup only chooses; it never grants.
- **Outside the setup** a call runs nothing. Goblin gets `{ kind: 'not-in-topic' }` and the owner an "Add to #Topic"
  card; a Persona, a subagent or a routine gets words.
- **Goblin may change setups when the owner asks** (`topic_create` with a setup, `topic_setup`, the Persona tools),
  only adding what the owner allows now, with receipts and Undo.
- **Routines are bounded by their Topic**: a run may call only allowed tools its Topic holds. A save names the routines
  it leaves short, and a routine's card flags allowed tools outside its Topic.
- **Naming**: the umbrella word is *setup*; the UI says "MCP servers & skills". "Capabilities" is retired in code
  (`setup/`, `Setups`, `SetupScope`).

## Commits

| Commit | What |
| --- | --- |
| `8e8ea3fe` | ADR 0040; glossary Capabilities → Setup |
| `6509af99` | contracts: `TopicSetup`, `PersonaSetup`, `SetupItem`, pure helpers |
| `ae301e4c` | each Topic stores a setup (migration `20261028000000_topic_setup`) |
| `0b06dc22` | the resolver bounds every chat by its Topic's setup; `not-in-topic` refusal |
| `d2ebc89c` | Persona setup (migration `20261028000100_persona_setup`, `app_persona_forks`) |
| `52650f5a` | per-conversation switches removed; owner rows dropped once at start |
| `1cce44d0` | rename capabilities → setup (mechanical) |
| `094d047c` | per-skill selection, asked before any load or read |
| `5ae4e880` | `PATCH /topics/:id/setup`, `GET /setup/catalog`, `topic.setup` receipts with Undo |
| `7cf671f1` | Goblin's `topic_setup`, setups on `topic_create` and the Persona tools |
| `c8a0a4a2` | native-scopes probe fix for the permuted primary binding |
| `4e6bfb75` | `RoutineView.topic` and `outsideSetup` |
| `3230a6a3` | web: the picker and its three doors (create dialog, Topic menu, composer button) |
| `22b55150` | web: a Persona's setup section |
| `8a09055a` | web: the "Add to #Topic" card |
| `b8ba80f4`, `035ae3e6` | `<apps>` lists only a chat's apps; a new app joins a Topic that lists its apps |
| `03ce315f` | web: a routine's card flags tools outside its Topic |
| `d449ffb9` | `ui:acceptance` opens the setup editor |

## Evidence

- **Unit** (node:sqlite, real migrations): runtime 614, web 524, contracts 52, all green at `d449ffb9`.
- **Workerd integration**: regular 81/81 and permuted 70/70, at `c8a0a4a2` and in the full gate at `d449ffb9`. The
  cases include the setup scenario (Topic with one tool and no subagents), the Persona setup scenario, the scoped
  approval, native scopes and the composer probe.
- **Full gate**: `heavy bun run check` at `d449ffb9` passed: 0 lint/Effect/Knip findings, every suite, the build.
- **Browser fixture**: `heavy bun apps/web/test/ui-setup.ts` passed (desktop and phone, light and dark). Screenshots
  are under `.local/goblin-acceptance/setup-*`. This is fixture evidence only.

## Release

- **First dev release: `d449ffb9`.** CI run 38078725738 was green. Release receipt `20261010T191930Z`, Worker
  version `80e2c84f`, authenticated smoke and drift verified by the release script. An earlier dev release by a
  parallel session at `c8a0a4a2` had already applied both migrations and the switch drop.
- **`ui:acceptance` against `d449ffb9`.** The first run failed only my new `setup.opens` check on every viewport: it
  counted the picker's tabs before the catalog had loaded. Fixed in `75d7299e`. The rerun had 0 failures, 0 errors and
  64 screenshots (`.local/goblin-acceptance/ui-2026-10-10T19-30-57-414Z`).
- **Live on dev, as the owner** (`.local/setup-acceptance/`, uncommitted scripts; test data only). The probe tool is
  `coding_read` on a coding-runner fixture server whose tunnel is gone, so "got past the setup" shows as an upstream
  transport error, not a result.

  | Step | What happened |
  | --- | --- |
  | Topic "Setup check 1937" made with nothing in its setup | Goblin's `mcp_call` was refused `not-in-topic` |
  | Owner added the server (`PATCH …/setup`) | The same call got past the setup (UpstreamMcp transport) |
  | Server removed again; Persona "Scout 1937" adds it | The Persona's call got past the setup, while Goblin's had been refused |
  | Goblin proposed a routine there | `RoutineView` carried `topic: 2` and `outsideSetup: [server · coding_read]` |
  | Goblin asked to create "Setup made 1937" with only that server | Its first `topic_create` gave plain names and was refused by the schema; the retry made the Topic, `createdBy: agent` with exactly that setup |
  | A fresh refusal, opened in the browser | The "Add to #Setup check 1937" card showed on phone and desktop; clicking Add (desktop) changed the setup, Goblin continued and the composer read "1 MCP server · no skills · no apps" |

- **Found on dev, fixed after the first release:**
  - two identical cards when the agent was refused the same thing twice in a turn (`a80d1d5e`);
  - the composer's setup summary ran under Send on a phone (`a80d1d5e`);
  - the setup tools now spell out item shapes (`2eeca4a7`);
  - the Persona setup section overflowed a phone (`53ccaadc`).

- **Second dev release: `53ccaadc`.** The full gate passed again (0 findings) and CI run 38081821324 was green.
  Receipt `20261010T201205Z`, Worker version `7ef75f05`, authenticated smoke and drift verified. `ui:acceptance` had
  0 failures, 0 errors and 64 screenshots (`.local/goblin-acceptance/ui-2026-10-10T20-16-00-841Z`). Live rechecks:
  - a fresh refusal showed one card on phone and desktop, and Add worked again;
  - the phone composer row shows only the setup icon;
  - the Persona page's setup section fits the phone, picker included.
- **`a5aaca88`:** the setup button's label said "everything" while the catalog of a narrowed Topic loaded; it now says
  "a chosen list". This is accessibility wording only.
- **Third dev deploy: `9359ef77`, with no receipt.** It carries `a5aaca88` and `4faef240`. With `4faef240`, a server's
  skills switch on even when its Events lack `skills.updated`/`skills.list_changed`; Sidequest's switch had reverted
  with "The request was not valid." The full gate passed and CI run 38088030492 was green.
  - Four `release dev` runs deployed it (Worker version `a54dab81`). Each smoke then failed on a model-driven or
    transient step, never one this range touches:
    - Meta `404 model not found` for `muse-spark-1.3-contributor`, three times: `app_not_built`, the first model
      turn, and after the subagent step;
    - one D1 "Network connection lost." on the auth store's `oauthResource` update (ref `a488d607d9d66c45`, read in
      Workers Logs).
  - `bun run drift:dev` verified on its own. A prod release of `9359ef77` needs a passing dev receipt first, so rerun
    `release dev` once Meta is steady.
- **Cleanup:** the acceptance's Topics (2, 3), the Persona "Scout 1937" and the proposed routine were archived on dev.

## For the owner

- On dev, every Topic still holds everything until you choose: from the Topic menu's "MCP servers & skills…", the
  button beside the composer, or when you create a Topic. A Persona's page has the same picker for what it adds.
- The per-conversation switches are gone. On dev, the owner's rows were deleted at the agent's first start on
  `c8a0a4a2`. That start writes a `job` line, kind `conversation-switches-dropped`, with the count. I did not read it
  in Workers Logs, because `goblin logs` needs Cloudflare credentials this session did not have. Prod still has its switches;
  releasing there drops them the same way.
- Prod waits for your go. `GOBLIN_CONFIRM_PROD=1 heavy bun run release prod 53ccaadc…` would need the matching dev
  receipt, which `20261010T201205Z` is.

## Not done, or done differently from the plan

- **No `app_routine_refusals` table.** A refused routine call is the words-only `not-in-topic` result, kept in the run
  ledger as code `not_in_topic`, and the routine's card flags the tools ahead of time. There is no separate refusals
  list on a run.
- **No unit test for `newAppJoinsTopic`.** It is typechecked and documented.
- **Renaming the app-wide "Connections" page to "MCP servers"** is deferred, as agreed.
- **Goblin's Telegram `send_message`** is an ordinary MCP tool under a Topic's setup. Moving messaging to mygram MCP is
  a separate change.
- **Not in v1**: Topic file attachments, featured Personas per Topic, pinned MCP Apps.
