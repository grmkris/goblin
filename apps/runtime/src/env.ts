import type { RpcResult } from './http/rpc.ts'
import type { MailBinding } from './auth/mail.ts'

/**
 * The Agent DO's RPC, what is left of it: account erasure. The owner and its callers (an inbound MCP client, a server's
 * key, ADR 0086) reach the agent through its typed API, and the Worker's hooks (MCP Events webhooks, file links) through
 * the internal one, both over `fetch` (`onRequest`, `http/api/server.ts`).
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
  /** Fixtures only: a published Events delivery's first retry delay in ms, 15 s unless set (`publish/policy.ts`). */
  readonly PUBLISH_RETRY_MS?: string
  /**
   * Fixtures only: what fetches a client's metadata document (ADR 0122, `auth/options.ts`). The deployed Worker uses
   * its own `fetch`, within the bounds the cimd plugin sets.
   */
  readonly CLIENT_METADATA_FETCH?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
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
   * The deployment owner's own workspace (ADRs 0087, 0089): the one offered `OWNER_MODELS`, models on the owner's own
   * subscriptions, comma-separated like `MODELS`. No other workspace sees them.
   */
  readonly OWNER_WORKSPACE_ID?: string
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
  /** The release's commit (`scripts/stage.ts`); every run event names it (ADR 0107). Unset on the local stack. */
  readonly VITE_GOBLIN_BUILD?: string
}
