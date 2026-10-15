// Sign-in through the deployment's identity provider (an OpenID Connect provider), in the auth page's look: one button
// that leaves for the provider, and the line that sets it apart from the emailed code.
import { KeyRoundIcon } from 'lucide-react'
import { Button } from '../components/button.tsx'
import { FieldError } from '../components/field.tsx'
import { ActionIcon } from './action-icon.tsx'
import { type AuthActionResult, SIGN_IN_LABELS } from './contract.ts'
import { useAction } from './use-action.ts'

export interface ProviderSignInProps {
  /** The button's words, as the deployment names its provider ("Sign in with mysi"). */
  readonly label: string
  /** Starts the provider's sign-in. It leaves the page when it works, so only a failure comes back to show. */
  readonly onSignIn: () => Promise<AuthActionResult>
  readonly disabled?: boolean | undefined
  /** What a thrown failure shows; a returned one shows its own words. */
  readonly failed?: string | undefined
}

/** The provider's button, its turning circle while the sign-in starts, and why it did not start. */
export function ProviderSignIn({ label, onSignIn, disabled, failed }: ProviderSignInProps) {
  const action = useAction(failed ?? SIGN_IN_LABELS.failed)
  return (
    <div data-method="oidc" className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        disabled={action.busy || disabled === true}
        aria-busy={action.busy}
        onClick={() => void action.run(onSignIn)}
      >
        <ActionIcon icon={KeyRoundIcon} busy={action.busy} />
        {label}
      </Button>
      {action.error !== null && <FieldError>{action.error}</FieldError>}
    </div>
  )
}

/** The quiet line between two ways to sign in. */
export function SignInDivider({ label = 'or' }: { readonly label?: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}
