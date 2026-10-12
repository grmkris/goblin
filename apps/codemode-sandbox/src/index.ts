// The codemode sandbox Worker (spike): one Durable Object class that runs durable code mode's scripts for the agent
// Worker, which binds it by script name (apps/web/alchemy.run.ts). Scripts run in this isolate, so a script that
// computes holds this object, not the agent's. Reached only through the binding; HTTP gets a 404.
export { CodemodeSandboxDurableObject as CodemodeSandbox } from '@earendil-works/pi-codemode/cloudflare'

export default {
  fetch: () => new Response('Not found', { status: 404 }),
}
