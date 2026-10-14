import { worker } from './http/worker.ts'

export { PersonalAgent } from './agent.ts'

/** The deployed Worker: the agent's Durable Object class and its request handler (`http/worker.ts`). */
export default worker
