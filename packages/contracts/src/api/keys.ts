import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { ApiKeyView, CreateApiKeyTerms, CreatedApiKey, UpdateApiKeyTerms } from '../account.ts'
import { API_ERRORS } from './errors.ts'

/** A key's id in a path. */
const KeyId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))

/**
 * The workspace's API keys for servers it runs (ADR 0081), served by the Worker for one of its owners and admins and
 * never for a key. Paths are relative to the API's `/api` prefix. What a key may do is its grant (ADR 0114).
 *
 * - `list`: `GET /api/keys`, every key with its grant, newest first, without secrets.
 * - `create`: `POST /api/keys` with the key's name and its grant's terms, 201 with the key and its secret, which is
 *   never shown again.
 * - `update`: `PATCH /api/keys/:keyId` gives the key's grant new terms; it keeps its id and secret. A key of another
 *   workspace's, or one that is gone, is not found.
 * - `rotate`: `POST /api/keys/:keyId/rotate` gives the key a new secret (ADR 0105), answered with the key as `create`
 *   answers it and never shown again; it keeps its id and grant, and the old secret admits nothing from then on. A key
 *   of another workspace's, or one that is gone or whose grant ended, is not found.
 * - `revoke`: `DELETE /api/keys/:keyId` ends the key and its grant at once.
 */
export class KeysGroup extends HttpApiGroup.make('keys').add(
  HttpApiEndpoint.get('list', '/keys', { success: Schema.Array(ApiKeyView), error: API_ERRORS }),
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
  HttpApiEndpoint.post('rotate', '/keys/:keyId/rotate', {
    params: { keyId: KeyId },
    success: CreatedApiKey,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.delete('revoke', '/keys/:keyId', {
    params: { keyId: KeyId },
    success: Schema.Struct({ revoked: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}
