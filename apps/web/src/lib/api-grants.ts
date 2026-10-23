/**
 * Release A's account endpoints (ADR 0114) as the web calls them, from the grant contracts, before `AccountApi` and
 * `WorkspaceAccountApi` carry them: the grants group (the person's consent and widening pages), and a key made and
 * changed by its grant's terms. The paths are theirs, so once the Worker's own groups take `GrantsGroup`,
 * `CreateApiKeyTerms` and `UpdateApiKeyTerms`, `account/queries.ts` calls `account` and `workspaceAccount` instead and
 * this module goes.
 */
import { ApiKeyView, CreateApiKeyTerms, CreatedApiKey, UpdateApiKeyTerms } from '@goblin/contracts'
import { API_ERRORS, GrantsGroup } from '@goblin/contracts/api'
import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { apiHeaders, inThisWorkspace } from './api.ts'
import { makeApiQuery } from './query/api-query.ts'

/**
 * The person's grants, answered by the Worker outside any workspace.
 *
 * @internal exported for the tests' fake Worker, which serves exactly this API.
 */
export class GrantsAccountApi extends HttpApi.make('goblin-grants').add(GrantsGroup).prefix('/api') {}

/** A key's id in a path, as `KeysGroup` takes it. */
const KeyId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))

/** `POST /api/keys` and `PATCH /api/keys/:keyId` with a grant's terms, under the page's workspace. */
class KeyTermsGroup extends HttpApiGroup.make('keys').add(
  HttpApiEndpoint.post('create', '/keys', {
    payload: CreateApiKeyTerms,
    success: CreatedApiKey.pipe(HttpApiSchema.status(201)),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.patch('update', '/keys/:keyId', {
    params: { keyId: KeyId },
    payload: UpdateApiKeyTerms,
    success: ApiKeyView,
    error: API_ERRORS,
  }),
) {}
/** @internal exported for the tests' fake Worker, which serves exactly this API. */
export class KeyTermsApi extends HttpApi.make('goblin-key-terms').add(KeyTermsGroup).prefix('/api') {}

/** The person's grants: the consent and widening pages' terms, and approving them. */
export const grantsAccount = makeApiQuery({
  id: 'goblin/GrantsAccountApi',
  client: HttpApiClient.make(GrantsAccountApi),
  headers: apiHeaders,
})

/** Making and changing this workspace's keys by their grant's terms. */
export const keyTerms = makeApiQuery({
  id: 'goblin/KeyTermsApi',
  client: HttpApiClient.make(KeyTermsApi, { transformClient: inThisWorkspace }),
  headers: apiHeaders,
})
