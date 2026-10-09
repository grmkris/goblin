import { DecisionLabel } from '@goblin/contracts'
import type { AgentRpc } from '../env.ts'
import { readJson } from '../http/body.ts'
import { NotFound } from '../http/errors.ts'
import { unwrap } from '../http/rpc.ts'

export async function decisionRoute(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  path: string,
): Promise<Response> {
  const id = /^\/api\/decisions\/(dp_[\w-]{1,120})$/u.exec(path)?.[1]
  if (id === undefined || request.method !== 'POST') throw new NotFound({ what: 'decision route' })
  const { label } = await readJson(request, DecisionLabel)
  return Response.json(unwrap(await agent.labelDecision(id, label)))
}
