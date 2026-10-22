import { createFileRoute } from '@tanstack/react-router'
import { SignInElsewhere } from '../components/sign-in-elsewhere.tsx'

/** A sign-in that belongs to another workspace (ADR 0096): a person's own page, outside any workspace. */
export const Route = createFileRoute('/connect-elsewhere')({ component: SignInElsewhere })
