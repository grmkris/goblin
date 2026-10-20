import type { RpcResult } from './http/rpc.ts'
import type { MailBinding } from './auth/mail.ts'

/**
 * The Agent DO's RPC, what is left of it: account erasure. The owner reaches the agent through its typed API and the
 * Worker's other callers (an inbound MCP client, myagent's doorbell, MCP Events) through the internal one, both over
 * `fetch` (`onRequest`, `http/api/server.ts`).
 */
export interface AgentRpcMethods {
  readonly deleteAgentData: () => Promise<RpcResult<true>>
}
export type AgentRpc = AgentRpcMethods & Rpc.DurableObjectBranded

export interface RuntimeEnv {
  readonly AGENTS: DurableObjectNamespace<AgentRpc>
  readonly AUTH_DB: D1Database
  /**
   * The owner's larger files (over 128 KiB), under `agents/<user>/` (ADR 0022). Optional (ADR 0064): without it every
   * file stays in the agent's SQLite and none may be larger.
   */
  readonly FILES?: R2Bucket
  readonly FLOWS?: AnalyticsEngineDataset
  /**
   * Dynamic Workers: every agent app release, the app transpiler and `code_run` scripts run in one (ADR 0021).
   * Optional (ADR 0064): without it the agent has no app or `code_run` tools.
   */
  readonly LOADER?: WorkerLoader
  readonly APP_URL: string
  readonly BETTER_AUTH_SECRET: string
  /** Cloudflare Email Sending; with `MAIL_SENDER` it turns on email verification (`auth/mail.ts`). */
  readonly MAIL?: MailBinding
  readonly MAIL_SENDER?: string
  /** `open`, `invite` (needs `SIGNUP_INVITE_CODE`) or `closed`; anything else counts as `closed`. */
  readonly SIGNUP_MODE?: string
  readonly SIGNUP_INVITE_CODE?: string
  /**
   * The deployment's OpenID Connect provider (ADR 0064, `auth/oidc.ts`): its issuer, the client goblin is registered
   * as and that client's secret, all three or none, and the sign-in button's words.
   */
  readonly OIDC_ISSUER?: string
  readonly OIDC_CLIENT_ID?: string
  readonly OIDC_CLIENT_SECRET?: string
  readonly OIDC_LABEL?: string
  /**
   * The deployment's own model endpoint (`models.ts` `deploymentEndpoint`): an OpenAI-compatible base URL, its key and
   * the default model, all three or none (ADR 0064). Without them each owner brings their own (ADR 0059).
   */
  readonly MODEL_BASE_URL?: string
  /** The default model; also the first one offered. */
  readonly MODEL_ID?: string
  /** More model names users may pick, comma-separated (`models.ts`). */
  readonly MODELS?: string
  readonly MODEL_KEY?: string
  /**
   * The deployment's owner (ADR 0087): the one account offered `OWNER_MODELS`, models on the owner's own subscriptions,
   * comma-separated like `MODELS`. No other account sees them.
   */
  readonly OWNER_USER_ID?: string
  readonly OWNER_MODELS?: string
  /** The cheapest offered model, for thread titles and main's memory (`models.ts` `memoryModelId`). */
  readonly MEMORY_MODEL?: string
  /** Native fixture only: tokens main runs past its memory view before a new one (`memory.ts` `FOLD_TOKENS`). */
  readonly MEMORY_FOLD_TOKENS?: string
  /** The most tokens one account's model calls may use in a UTC day, a positive whole number; unset, no cap. */
  readonly DAILY_TOKEN_CAP?: string
  /** JSON list of outbound MCP servers every account has: `[{ connectionId, endpoint, label?, issuer?, resource? }]`. */
  readonly MCP_SERVERS?: string
  /** Shelf entries that replace goblin's by id or add to them, a JSON list (`mcp/servers/shelf.ts`). */
  readonly MCP_SHELF?: string
  /** 32 random bytes, base64: encrypts outbound OAuth credentials at rest. */
  readonly CREDENTIAL_KEY: string
  readonly STAGE?: 'local' | 'dev' | 'prod' | 'test'
}
