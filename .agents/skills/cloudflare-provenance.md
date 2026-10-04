# Cloudflare skill provenance and Purrable precedence

The generic skills `durable-objects`, `workers-best-practices`, and `wrangler` come from cloudflare/skills@b052c32bab7dd493513260228a36c88294f343f1 through the clean MyApps checkout recorded in sources.json. Each keeps its Apache-2.0 license, original SKILL.md, and every referenced file. The recorded upstream SKILL.md hashes match the copies.

Purrable instructions take precedence over generic examples: Alchemy is the only infrastructure/deployment authority; do not create an independently maintained Wrangler stack. Use one native `PersonalAgent extends Agent` Durable Object per agent identity with SQLite. Pi Durable and PiHarness own their verified vendor storage; application Drizzle code only owns `app_*` tables. Never assume a table prefix enumerates vendor ownership. Keep initialization and application migrations idempotent and short; no lifecycle gate or transaction spans external work. Alarms/model limits and reconstruction claims require the actual pinned API and tests.

Select the Workers test harness from the compatibility spike. Generic Cloudflare test examples are references, not proof of compatibility with Purrable pins. Record local workerd, instance reconstruction, and isolated dev acceptance separately. Skill updates must retain licenses and revise sources.json at an exact commit.
