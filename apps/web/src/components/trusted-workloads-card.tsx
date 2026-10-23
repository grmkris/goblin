import { useState, useSyncExternalStore } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import type { TrustedWorkloadView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
} from '@goblin/ui'
import { keysQuery } from '../account/queries.ts'
import {
  createTrustedWorkloadMutation,
  disableTrustedWorkloadMutation,
  trustedWorkloadsQuery,
} from '../account/workloads.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { WorkloadPolicyForm } from './oidc/policy-form.tsx'

function WorkloadRow({ workload }: { readonly workload: TrustedWorkloadView }) {
  const disable = useMutation(disableTrustedWorkloadMutation)
  const [confirming, setConfirming] = useState(false)
  return (
    <li className="pick-row flex-wrap">
      <span className="grant-text min-w-0 basis-64">
        <strong>{workload.label}</strong>
        <span className="break-all text-sm text-muted-foreground">{workload.policy.issuer}</span>
        <span className="text-sm text-muted-foreground">
          {Object.entries(workload.policy.claims)
            .map(([name, values]) => `${name}: ${values.join(', ')}`)
            .join(' · ')}
        </span>
      </span>
      {workload.disabledAt === undefined ? (
        <Button variant="outline" onClick={() => setConfirming(true)}>
          Disable {workload.label}
        </Button>
      ) : (
        <Badge variant="secondary">Disabled</Badge>
      )}
      {confirming && (
        <div className="inline-confirm" role="alertdialog" aria-label={`Disable ${workload.label}?`}>
          <span>End this policy's access? Its next request will be refused.</span>
          <Button
            variant="destructive"
            pending={disable.isPending}
            onClick={() => disable.mutate(workload.id, { onSuccess: () => setConfirming(false) })}
          >
            Disable trust
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
      {disable.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{messageOf(disable.error, 'disable that policy')}</AlertDescription>
        </Alert>
      )}
    </li>
  )
}

function Workloads() {
  const policies = useSuspenseQuery(trustedWorkloadsQuery).data
  const keys = useSuspenseQuery(keysQuery).data
  const create = useMutation(createTrustedWorkloadMutation)
  const [grantId, setGrantId] = useState('')
  const [retire, setRetire] = useState(false)
  const audience = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => '',
  )
  return (
    <FieldGroup>
      {policies.length === 0 ? (
        <p className="server-note">No trusted workloads yet.</p>
      ) : (
        <ul className="pick-list">
          {policies.map((workload) => (
            <WorkloadRow key={workload.id} workload={workload} />
          ))}
        </ul>
      )}
      {create.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{messageOf(create.error, 'save that policy')}</AlertDescription>
        </Alert>
      )}
      {create.isSuccess && <p role="status">Trust policy saved.</p>}
      <Field>
        <FieldLabel htmlFor="workload-grant">Server grant</FieldLabel>
        <NativeSelect id="workload-grant" value={grantId} onChange={(event) => setGrantId(event.target.value)}>
          <NativeSelectOption value="">Choose a server's grant</NativeSelectOption>
          {keys.map((key) => (
            <NativeSelectOption key={key.grantId} value={key.grantId}>
              {key.name} · {key.terms.level}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          The workload keeps this server's access, Topics, Personas and MCP origins. Edit its access under API keys.
          Make a server key there first if needed.
        </FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="workload-retire" checked={retire} onCheckedChange={setRetire} />
        <FieldLabel htmlFor="workload-retire">Stop accepting this key's static secret when saving</FieldLabel>
      </Field>
      <WorkloadPolicyForm
        audience={audience}
        pending={create.isPending}
        disabled={grantId === '' || audience === ''}
        onSubmit={(policy) => create.mutate({ policy, grantId, disableKeySecret: retire })}
      />
    </FieldGroup>
  )
}

/** Owner/admin trust management, using the same authenticated account API as server grants. */
export function TrustedWorkloadsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trust a workload</CardTitle>
        <CardDescription>
          Let GitHub Actions or a custom issuer such as Swarmm present short-lived tokens in place of a server secret.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary action="read trusted workloads" pending={<Skeleton className="h-24 w-full" />}>
          <Workloads />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
