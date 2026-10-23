// Adapted from OIDC UI provider-github/provider-custom. Goblin uses its own primitives, exact branch subjects,
// the runtime origin as audience, and the existing server grant rather than provider-specific permissions.
import { type SubmitEvent, useState } from 'react'
import { type OidcPolicy, validateOidcPolicy } from '@goblin/contracts'
import {
  Button,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@goblin/ui'

interface Fields {
  readonly provider: string
  readonly issuer: string
  readonly repository: string
  readonly branch: string
  readonly subject: string
  readonly label: string
}
const INITIAL: Fields = { provider: 'github', issuer: '', repository: '', branch: '', subject: '', label: '' }

/** GitHub and custom providers compile into exactly the same registry policy contract. */
const compile = (fields: Fields, audience: string): OidcPolicy => ({
  issuer: fields.provider === 'github' ? 'https://token.actions.githubusercontent.com' : fields.issuer.trim(),
  label: fields.label.trim(),
  claims:
    fields.provider === 'github'
      ? {
          aud: [audience],
          repository: [fields.repository.trim()],
          ref: [`refs/heads/${fields.branch.trim()}`],
          sub: [`repo:${fields.repository.trim()}:ref:refs/heads/${fields.branch.trim()}`],
        }
      : { aud: [audience], sub: [fields.subject.trim()] },
})

function GithubFields({ fields, onChange }: { readonly fields: Fields; readonly onChange: (fields: Fields) => void }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="workload-repository">Repository</FieldLabel>
        <Input
          id="workload-repository"
          placeholder="owner/repository"
          required
          pattern="[A-Za-z0-9-]+/[A-Za-z0-9_.-]+"
          value={fields.repository}
          onChange={(event) => onChange({ ...fields, repository: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="workload-branch">Branch</FieldLabel>
        <Input
          id="workload-branch"
          placeholder="dev"
          required
          value={fields.branch}
          onChange={(event) => onChange({ ...fields, branch: event.target.value })}
        />
        <FieldDescription>
          Only this repository and branch. Environment and pull-request subjects need a custom policy.
        </FieldDescription>
      </Field>
    </>
  )
}

function CustomFields({ fields, onChange }: { readonly fields: Fields; readonly onChange: (fields: Fields) => void }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="workload-issuer">Issuer</FieldLabel>
        <Input
          id="workload-issuer"
          placeholder="https://api.example.com"
          type="url"
          required
          value={fields.issuer}
          onChange={(event) => onChange({ ...fields, issuer: event.target.value })}
        />
        <FieldDescription>Public https discovery root. For Swarmm, use its API origin exactly.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="workload-subject">Subject</FieldLabel>
        <Input
          id="workload-subject"
          placeholder="swarmm:prod"
          required
          value={fields.subject}
          onChange={(event) => onChange({ ...fields, subject: event.target.value })}
        />
        <FieldDescription>Exact sub claim. Wildcards are literal characters.</FieldDescription>
      </Field>
    </>
  )
}

/** Registry provider forms, narrowed to GitHub branch trust and a custom issuer such as Swarmm. */
export function WorkloadPolicyForm(props: {
  readonly audience: string
  readonly pending: boolean
  readonly disabled: boolean
  readonly onSubmit: (policy: OidcPolicy) => void
}) {
  const [fields, setFields] = useState(INITIAL)
  const policy = compile(fields, props.audience)
  const valid = validateOidcPolicy(policy).length === 0 && fields.label.trim() !== ''
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (valid) props.onSubmit(policy)
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="workload-label">Workload name</FieldLabel>
          <Input
            id="workload-label"
            required
            maxLength={100}
            value={fields.label}
            onChange={(event) => setFields({ ...fields, label: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="workload-provider">Provider</FieldLabel>
          <NativeSelect
            id="workload-provider"
            value={fields.provider}
            onChange={(event) => setFields({ ...fields, provider: event.target.value })}
          >
            <NativeSelectOption value="github">GitHub Actions</NativeSelectOption>
            <NativeSelectOption value="custom">Custom issuer / Swarmm</NativeSelectOption>
          </NativeSelect>
        </Field>
        {fields.provider === 'github' ? (
          <GithubFields fields={fields} onChange={setFields} />
        ) : (
          <CustomFields fields={fields} onChange={setFields} />
        )}
        <Field>
          <FieldLabel htmlFor="workload-audience">Audience</FieldLabel>
          <Input id="workload-audience" readOnly value={props.audience} />
          <FieldDescription>Request the token for this origin. Tokens must expire within ten minutes.</FieldDescription>
        </Field>
        <Button type="submit" pending={props.pending} disabled={props.disabled || !valid}>
          Save trust policy
        </Button>
      </FieldGroup>
    </form>
  )
}
