import { RunAttribute, type RunAttributes, type RunEventKind } from '@goblin/contracts/telemetry'
import type { RuntimeEnv } from '../env.ts'
import { deploymentEndpoint } from '../models.ts'
import type { RunStamp } from './events.ts'

/** What run events read from the deployment: its release and its own model endpoint. */
export type RanWithEnv = Partial<
  Pick<RuntimeEnv, 'VITE_GOBLIN_BUILD' | 'MODEL_BASE_URL' | 'MODEL_ID' | 'MODEL_KEY' | 'MODELS'>
>

const MODEL_CALLS: ReadonlySet<RunEventKind> = new Set(['model.attempt', 'model.aux'])

/** The deployment endpoint's host and port; none when its base URL does not parse. */
function serverOf(baseUrl: string): RunAttributes {
  if (!URL.canParse(baseUrl)) return {}
  const url = new URL(baseUrl)
  const port = url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port)
  return { [RunAttribute.serverAddress]: url.hostname, [RunAttribute.serverPort]: port }
}

/**
 * What every run event ran with (ADR 0107): the release's commit; and for a model call, the endpoint it went to, read
 * as `Inference` reads it when the call starts: the owner's own when they set one (`ownEndpoint`, never its address),
 * else the deployment's with its host and port, else none.
 */
export function ranWith(env: RanWithEnv, ownEndpoint: () => boolean): RunStamp {
  const build = env.VITE_GOBLIN_BUILD?.trim() ?? ''
  const release: RunAttributes = build === '' ? {} : { [RunAttribute.agentVersion]: build }
  const deployment = deploymentEndpoint(env)
  const shared: RunAttributes =
    deployment === undefined
      ? { [RunAttribute.modelEndpoint]: 'none' }
      : { [RunAttribute.modelEndpoint]: 'deployment', ...serverOf(deployment.baseUrl) }
  return (kind) =>
    MODEL_CALLS.has(kind)
      ? { ...release, ...(ownEndpoint() ? { [RunAttribute.modelEndpoint]: 'owner' } : shared) }
      : release
}
