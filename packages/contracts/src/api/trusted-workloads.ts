import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { CreateTrustedWorkload, TrustedWorkloadView } from '../oidc.ts'
import { API_ERRORS } from './errors.ts'

const WorkloadId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))

export class TrustedWorkloadsGroup extends HttpApiGroup.make('trustedWorkloads').add(
  HttpApiEndpoint.get('list', '/trusted-workloads', {
    success: Schema.Array(TrustedWorkloadView),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('create', '/trusted-workloads', {
    payload: CreateTrustedWorkload,
    success: TrustedWorkloadView.pipe(HttpApiSchema.status(201)),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('disable', '/trusted-workloads/:id/disable', {
    params: { id: WorkloadId },
    success: Schema.Struct({ disabled: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}
