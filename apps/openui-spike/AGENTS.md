# OpenUI spike

An isolated, fixture-driven browser playground. Read the root instructions first. Use Goblin's UI and kit;
import the production reply renderer from `@goblin/web/replies`, so the preview cannot drift from chat. No authentication, model endpoint, MCP provider,
owner data or mutations. Action receipts stay in browser memory. The preview is public.

Alchemy owns the independent `goblin-openui-spike` stack, with local state and stage-derived Worker names.
Deploy only this stack for the preview; never point it at Goblin's dev/prod resources. Keep browser tests against
the built assets and the deployed URL separate from model-generation or authenticated integration evidence.
