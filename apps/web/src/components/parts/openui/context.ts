import { createContext } from 'react'

/** The containing chat's normal owner submission. Absent for quoted messages and read-only views. */
export const ReplySend = createContext<((input: string) => Promise<boolean>) | undefined>(undefined)
