import type {
  InvitationPreview,
  InvitationView,
  InviteMembers,
  InviteSent,
  MemberView,
  WorkspaceRole,
  WorkspaceView,
} from '@goblin/contracts'
import { type AppError, Conflict } from '@goblin/contracts/api'
import type * as Effect from 'effect/Effect'
import { inviteMail, mailerOf } from '../../auth/mail.ts'
import {
  acceptInvitation,
  cancelInvitation,
  declineInvitation,
  invitationPreview,
  invitationsFor,
  invitationsOf,
  inviteMembers,
  leaveWorkspace,
  membersOf,
  removeMember,
  renewInvitation,
  updateMemberRole,
} from '../../auth/members.ts'
import type { Person } from '../../auth/workspaces.ts'
import type { RuntimeEnv } from '../../env.ts'
import { offersOwnerModels } from '../../models.ts'
import { writeLine } from '../../observability/logger.ts'
import { safeErrorType } from '../../observability/report.ts'
import { attempt } from '../errors.ts'

/**
 * A workspace's members and invitations, and a person's invitations (ADR 0093), as the account APIs answer them from
 * the auth D1 (`auth/members.ts`). `actor` is the member acting, with their role in the workspace.
 */
export interface MemberRecords {
  readonly list: (workspaceId: string) => Effect.Effect<readonly MemberView[], AppError>
  readonly update: (actor: WorkspaceView, userId: string, role: WorkspaceRole) => Effect.Effect<MemberView, AppError>
  readonly remove: (actor: WorkspaceView, person: Person, userId: string) => Effect.Effect<void, AppError>
  readonly leave: (workspace: WorkspaceView, person: Person) => Effect.Effect<void, AppError>
  readonly invitations: (workspaceId: string) => Effect.Effect<readonly InvitationView[], AppError>
  /** Invitations for `input`'s addresses, each mailed with its link; `mailed: false` when its mail did not go out. */
  readonly invite: (
    actor: WorkspaceView,
    person: Person,
    input: InviteMembers,
  ) => Effect.Effect<readonly InviteSent[], AppError>
  readonly cancel: (workspaceId: string, id: string) => Effect.Effect<void, AppError>
  readonly resend: (actor: WorkspaceView, person: Person, id: string) => Effect.Effect<InviteSent, AppError>
  /** The invitations waiting for the person's address. */
  readonly mine: (person: Person) => Effect.Effect<readonly InvitationPreview[], AppError>
  readonly preview: (id: string) => Effect.Effect<InvitationPreview, AppError>
  readonly accept: (person: Person, id: string) => Effect.Effect<WorkspaceView, AppError>
  readonly decline: (person: Person, id: string) => Effect.Effect<void, AppError>
}

/** Who a mail names as the inviter: their name, or their address. */
const nameOf = (person: Person): string => (person.name.trim() === '' ? person.email : person.name.trim())

/** The records as the deployment keeps them, its invitations mailed from its own sender. */
export const memberRecords = (env: RuntimeEnv): MemberRecords => {
  /** Mails `invitation` for `actor`'s workspace from `person`; whether it went out (a failure is logged, not thrown). */
  const mail = async (actor: WorkspaceView, person: Person, invitation: InvitationView): Promise<InviteSent> => {
    const mailer = mailerOf(env)
    if (mailer === undefined) return { invitation, mailed: false }
    try {
      await mailer.binding.send(
        inviteMail({
          from: mailer.from,
          to: invitation.email,
          workspace: actor.name,
          inviter: nameOf(person),
          link: `${new URL(env.APP_URL).origin}/invite/${invitation.id}`,
          appUrl: env.APP_URL,
          ...(env.STAGE === undefined ? {} : { stage: env.STAGE }),
        }),
      )
      return { invitation, mailed: true }
    } catch (cause) {
      // The owner is told it did not go out and can share its link; the operator sees the mailer's failure here.
      writeLine('error', { event: 'failure', where: 'members.inviteMail', 'error.type': safeErrorType(cause) })
      return { invitation, mailed: false }
    }
  }
  const db = env.AUTH_DB
  return {
    list: (workspaceId) => attempt(() => membersOf(db, workspaceId)),
    update: (actor, userId, role) => attempt(() => updateMemberRole(db, actor, userId, role)),
    remove: (actor, person, userId) => attempt(() => removeMember(db, actor, person.id, userId, new Date())),
    leave: (workspace, person) => attempt(() => leaveWorkspace(db, workspace, person.id, new Date())),
    invitations: (workspaceId) => attempt(() => invitationsOf(db, workspaceId, new Date())),
    invite: (actor, person, input) =>
      attempt(async () => {
        // The owner's own subscriptions serve them alone, so their workspace stays theirs alone (ADR 0095).
        if (offersOwnerModels(env, actor.id)) throw new Conflict({ reason: 'owner_models' })
        const made = await inviteMembers(db, actor, person.id, input, new Date())
        return Promise.all(made.map((invitation) => mail(actor, person, invitation)))
      }),
    cancel: (workspaceId, id) => attempt(() => cancelInvitation(db, workspaceId, id)),
    resend: (actor, person, id) =>
      attempt(async () => mail(actor, person, await renewInvitation(db, actor.id, id, new Date()))),
    mine: (person) => attempt(() => invitationsFor(db, person.email, new Date())),
    preview: (id) => attempt(() => invitationPreview(db, id, new Date())),
    accept: (person, id) => attempt(() => acceptInvitation(db, person, id, new Date())),
    decline: (person, id) => attempt(() => declineInvitation(db, person, id, new Date())),
  }
}
