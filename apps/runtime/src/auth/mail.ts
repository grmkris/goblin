/** The slice of the Cloudflare Email Sending binding goblin uses. */
export interface MailBinding {
  send(message: MailMessage): Promise<unknown>
}
export type MailMessage = {
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly text: string
}

/** A configured sender: the binding plus the `From` address it is allowed to use. Absent: code sending is unavailable. */
export type Mailer = { readonly binding: MailBinding; readonly from: string }

export const mailerOf = (env: { readonly MAIL?: MailBinding; readonly MAIL_SENDER?: string }): Mailer | undefined => {
  const from = env.MAIL_SENDER?.trim() ?? ''
  return env.MAIL === undefined || !/^[^\s@]+@[^\s@]+$/u.test(from) ? undefined : { binding: env.MAIL, from }
}

type MailStage = { readonly stage?: 'local' | 'dev' | 'prod' | 'test' }
const subjectPrefix = (input: MailStage & { readonly appUrl: string }): string =>
  input.stage === 'prod' ? '' : `[${new URL(input.appUrl).host}] `

/** A sign-in code. The subject never contains the code, so a lock-screen preview does not give it away. */
export const codeMail = (
  input: {
    readonly from: string
    readonly to: string
    readonly code: string
    readonly appUrl: string
  } & MailStage,
): MailMessage => ({
  from: input.from,
  to: input.to,
  subject: `${subjectPrefix(input)}Your goblin sign-in code`,
  text: [
    `Your goblin sign-in code is ${input.code}`,
    '',
    'It expires in 10 minutes and works once. If you did not try to sign in, ignore this email.',
  ].join('\n'),
})

/**
 * An invitation to a workspace (ADR 0093): who invited, to which workspace, and its link, which works for this address
 * alone for seven days.
 */
export const inviteMail = (
  input: {
    readonly from: string
    readonly to: string
    readonly workspace: string
    readonly inviter: string
    readonly link: string
    readonly appUrl: string
  } & MailStage,
): MailMessage => ({
  from: input.from,
  to: input.to,
  subject: `${subjectPrefix(input)}${input.inviter} invited you to ${input.workspace} on goblin`,
  text: [
    `${input.inviter} invited you to the workspace ${input.workspace} on goblin, where its people work with one agent.`,
    '',
    `Join: ${input.link}`,
    '',
    `Sign in with this address (${input.to}) to join. The invitation works for seven days. If you did not expect it, ignore this email.`,
  ].join('\n'),
})
