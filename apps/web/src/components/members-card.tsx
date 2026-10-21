// The Settings card about a workspace's people (ADR 0093): its members and their roles, inviting people, and leaving.
import { type SubmitEvent, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { InviteSent, MemberView, WorkspaceRole, WorkspaceView } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CopyButton,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Textarea,
} from '@goblin/ui'
import {
  cancelInvitationMutation,
  invitationsQuery,
  inviteMutation,
  leaveWorkspaceMutation,
  membersQuery,
  removeMemberMutation,
  resendInvitationMutation,
  updateMemberMutation,
} from '../account/queries.ts'
import { sessionPersonQuery } from '../auth/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'

const ROLE_WORDS: Readonly<Record<WorkspaceRole, string>> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** An invitation's own link, which works for its address alone. */
const linkOf = (id: string): string => `${window.location.origin}/invite/${id}`

/** Whether `actor` may change `target`'s role or remove them: an admin only a member, an owner anyone. */
const governs = (actor: WorkspaceRole, target: WorkspaceRole): boolean =>
  actor === 'owner' || (actor === 'admin' && target === 'member')

/** What the person reads when a change to the people could not be made. */
function refusal(failure: unknown, action: string): string {
  if (failure instanceof Conflict && failure.reason === 'last_owner')
    return withRef('A workspace keeps at least one owner: make someone else an owner first.', failure)
  if (failure instanceof Conflict && failure.reason === 'member')
    return withRef('One of those addresses is already a member.', failure)
  if (failure instanceof Conflict && failure.reason === 'owner_models')
    return withRef(
      'This workspace has your own subscription models, which serve only you. Make another workspace to work with others.',
      failure,
    )
  return messageOf(failure, action)
}

/** One member: their name and address, their role (which a governing owner or admin may change), and removing them. */
function MemberRow({
  member,
  actor,
  you,
}: {
  readonly member: MemberView
  readonly actor: WorkspaceRole
  readonly you: boolean
}) {
  const update = useMutation(updateMemberMutation)
  const remove = useMutation(removeMemberMutation)
  const failure = update.error ?? remove.error
  const changeable = !you && governs(actor, member.role)
  const roles: readonly WorkspaceRole[] = actor === 'owner' ? ['owner', 'admin', 'member'] : ['member']
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {member.name === '' ? member.email : member.name}
            {you && <span className="text-muted-foreground"> (you)</span>}
          </div>
          <div className="truncate text-sm text-muted-foreground">{member.email}</div>
        </div>
        {changeable ? (
          <NativeSelect
            size="sm"
            aria-label={`${member.name || member.email}'s role`}
            value={member.role}
            disabled={update.isPending}
            onChange={(event) => {
              const role = roles.find((each) => each === event.target.value)
              if (role !== undefined) update.mutate({ userId: member.userId, role })
            }}
          >
            {roles.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {ROLE_WORDS[role]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <span className="text-sm text-muted-foreground">{ROLE_WORDS[member.role]}</span>
        )}
        {changeable && (
          <Button variant="ghost" size="sm" pending={remove.isPending} onClick={() => remove.mutate(member.userId)}>
            Remove
          </Button>
        )}
      </div>
      {failure !== null && <p className="text-sm text-destructive">{refusal(failure, 'change that member')}</p>}
    </li>
  )
}

/** Inviting people by address, with the role they get; a mail that did not go out leaves its link to share. */
function Invite({ actor }: { readonly actor: WorkspaceRole }) {
  const invite = useMutation(inviteMutation)
  const [text, setText] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [unsent, setUnsent] = useState<readonly InviteSent[]>([])
  const emails = text
    .split(/[\s,;]+/u)
    .map((each) => each.trim())
    .filter((each) => each !== '')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (emails.length === 0) return
    invite.mutate(
      { emails, role },
      {
        onSuccess: (sent) => {
          setText('')
          setUnsent(sent.filter((each) => !each.mailed))
        },
      },
    )
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="invite-emails">Invite people</FieldLabel>
          <Textarea
            id="invite-emails"
            rows={2}
            value={text}
            placeholder="ana@example.com, bo@example.com"
            onChange={(event) => setText(event.target.value)}
          />
          <FieldDescription>
            They will see every channel, and Goblin will use this workspace's connections for them too.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <NativeSelect
            size="sm"
            aria-label="Their role"
            value={role}
            onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'member')}
          >
            <NativeSelectOption value="member">As members</NativeSelectOption>
            {actor === 'owner' && <NativeSelectOption value="admin">As admins</NativeSelectOption>}
          </NativeSelect>
          <Button type="submit" disabled={emails.length === 0} pending={invite.isPending}>
            Invite
          </Button>
        </Field>
        {invite.error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{refusal(invite.error, 'send the invitations')}</AlertDescription>
          </Alert>
        )}
        {unsent.length > 0 && (
          <Alert>
            <AlertDescription>
              Their invitation emails did not go out. Share each link yourself: it works for that address alone.
            </AlertDescription>
          </Alert>
        )}
      </FieldGroup>
    </form>
  )
}

/** The invitations still waiting: copy one's link, mail it again, or withdraw it. */
function Waiting() {
  const invitations = useQuery(invitationsQuery)
  const resend = useMutation(resendInvitationMutation)
  const cancel = useMutation(cancelInvitationMutation)
  const listed = invitations.data ?? []
  if (listed.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Invited, not joined yet</p>
      <ul className="flex flex-col gap-2">
        {listed.map((invitation) => (
          <li key={invitation.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate">{invitation.email}</div>
              <div className="text-sm text-muted-foreground">
                {ROLE_WORDS[invitation.role]} · until {new Date(invitation.expiresAt).toLocaleDateString()}
              </div>
            </div>
            <CopyButton text={linkOf(invitation.id)} label="Copy invitation link" compact />
            <Button variant="ghost" size="sm" onClick={() => resend.mutate(invitation.id)}>
              Resend
            </Button>
            <Button variant="ghost" size="sm" onClick={() => cancel.mutate(invitation.id)}>
              Withdraw
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Leaving the workspace, for anyone but its last owner. */
function Leave() {
  const leave = useMutation(leaveWorkspaceMutation)
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          pending={leave.isPending || leave.isSuccess}
          onClick={() => leave.mutate(undefined, { onSuccess: () => window.location.assign('/') })}
        >
          Leave this workspace
        </Button>
      </div>
      {leave.error !== null && <p className="text-sm text-destructive">{refusal(leave.error, 'leave')}</p>}
    </div>
  )
}

/** The workspace's people: every member sees who is in it; its owners and admins invite and manage them. */
export function MembersCard({ workspace }: { readonly workspace: WorkspaceView }) {
  const members = useQuery(membersQuery)
  const me = useQuery(sessionPersonQuery).data
  const managing = workspace.role !== 'member'
  return (
    <Card>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>
          Everyone here works with the same agent: its channels, connections and memory are the workspace's.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6">
          {members.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{messageOf(members.error, 'list the members')}</AlertDescription>
            </Alert>
          ) : members.data === undefined ? (
            <Skeleton className="h-16" />
          ) : (
            <ul className="flex flex-col gap-3">
              {members.data.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  actor={workspace.role}
                  you={me !== null && me !== undefined && member.email === me.email}
                />
              ))}
            </ul>
          )}
          {managing && <Invite actor={workspace.role} />}
          {managing && <Waiting />}
          <Leave />
        </div>
      </CardContent>
    </Card>
  )
}
