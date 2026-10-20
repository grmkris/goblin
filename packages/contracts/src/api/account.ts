import * as HttpApi from 'effect/http-api/HttpApi'
import { ClientErrorsGroup } from './client-errors.ts'
import { ClientsGroup } from './clients.ts'
import { KeysGroup } from './keys.ts'

/** What the Worker answers itself, without waking the agent: inbound clients, API keys and client crash reports. */
export class AccountApi extends HttpApi.make('goblin-account')
  .add(ClientsGroup, KeysGroup, ClientErrorsGroup)
  .prefix('/api') {}
