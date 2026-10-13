import { createContext, use, useEffect, useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import type { GoblinApi } from './api.ts'
// Extensionless so One selects client.native.ts on iOS and Android.
import { createClient } from './client'
import { SignIn } from './sign-in.tsx'
import { Action, styles } from './ui.tsx'

const Owner = createContext<GoblinApi | null>(null)
export const useOwner = () => {
  const owner = use(Owner)
  if (owner === null) throw new Error('The owner screen requires a session.')
  return owner
}
export function OwnerGate({ children }: { readonly children: ReactNode }) {
  const [api, setApi] = useState<GoblinApi>()
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    let disposed = false
    const client = createClient()
    setApi(client)
    client
      .hasSession()
      .then((found) => {
        if (!disposed) {
          setSignedIn(found)
          setReady(true)
        }
      })
      .catch(() => {
        // expected: offline restoration leaves the sign-in form with a visible explanation.
        if (!disposed) {
          setReady(true)
          setProblem('Could not restore your session. You can sign in again.')
        }
      })
    return () => {
      disposed = true
    }
  }, [])
  if (!ready || api === undefined)
    return (
      <View style={styles.page}>
        <Text style={styles.body}>Opening goblin…</Text>
      </View>
    )
  if (!signedIn) return <SignIn api={api} initialProblem={problem} onSignedIn={() => setSignedIn(true)} />
  const signOut = async () => {
    try {
      await api.signOut()
      setProblem('')
    } catch {
      // expected: the UI reports failed server revocation without promising that an HttpOnly cookie was cleared.
      setProblem('The server could not confirm sign-out. Check your connection before signing in again.')
    } finally {
      setSignedIn(false)
    }
  }
  return (
    <Owner value={api}>
      <View style={styles.fill}>
        <View style={styles.account}>
          <Text style={styles.wordmark}>goblin</Text>
          <Action label="Sign out" onPress={() => void signOut()} quiet />
        </View>
        {children}
      </View>
    </Owner>
  )
}
