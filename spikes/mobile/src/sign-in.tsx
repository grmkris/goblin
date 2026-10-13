import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native'
import type { GoblinApi } from './api.ts'
import { Action, styles } from './ui.tsx'

export function SignIn({
  api,
  onSignedIn,
  initialProblem,
}: {
  readonly api: GoblinApi
  readonly onSignedIn: () => void
  readonly initialProblem: string
}) {
  const { email, setEmail, otp, setOtp, invite, setInvite, sent, setSent, busy, problem, submit } = useSignIn(
    api,
    onSignedIn,
    initialProblem,
  )
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.form}>
          <Text style={styles.title}>Meet your goblin.</Text>
          <Text style={styles.body}>Your personal agent, wherever you are.</Text>
          <TextInput
            accessibilityLabel="Email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            placeholder="Email address"
            style={styles.input}
            value={email}
            editable={!sent && !busy}
            onChangeText={setEmail}
          />
          {!sent && (
            <TextInput
              accessibilityLabel="Invite code (optional)"
              placeholder="Invite code, if you have one"
              secureTextEntry
              autoCapitalize="none"
              style={styles.input}
              value={invite}
              onChangeText={setInvite}
            />
          )}
          {sent && <CodeInput otp={otp} setOtp={setOtp} />}
          <Action
            label={busy ? 'Please wait…' : sent ? 'Sign in' : 'Email me a code'}
            disabled={busy || email.trim() === '' || (sent && !/^\d{6}$/u.test(otp))}
            onPress={() => void submit()}
          />
          {sent && (
            <Action
              label="Use another email or resend"
              disabled={busy}
              onPress={() => {
                setSent(false)
                setOtp('')
              }}
            />
          )}
          {problem !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {problem}
            </Text>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function useSignIn(api: GoblinApi, onSignedIn: () => void, initialProblem: string) {
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [invite, setInvite] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(initialProblem)
  const submit = async () => {
    setBusy(true)
    setProblem('')
    try {
      if (sent) {
        await api.verifyCode(email.trim(), otp, invite)
        onSignedIn()
      } else {
        await api.sendCode(email.trim(), invite)
        setSent(true)
      }
    } catch (error) {
      // expected: OTP refusals and network failures are shown in the sign-in form.
      setProblem(error instanceof Error ? error.message : 'Could not sign in. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return { email, setEmail, otp, setOtp, invite, setInvite, sent, setSent, busy, problem, submit }
}

function CodeInput({ otp, setOtp }: { readonly otp: string; readonly setOtp: (value: string) => void }) {
  return (
    <>
      <Text style={styles.muted}>Enter the six-digit code we sent to your email.</Text>
      <TextInput
        accessibilityLabel="Sign-in code"
        autoComplete="one-time-code"
        keyboardType="number-pad"
        maxLength={6}
        placeholder="000000"
        style={styles.input}
        value={otp}
        onChangeText={setOtp}
      />
    </>
  )
}
