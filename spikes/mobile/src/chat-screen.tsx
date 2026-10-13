import { useEffect, useRef, useState } from 'react'
import { AppState, FlatList, KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native'
import type { ChatMessage } from '../../../apps/web/src/lib/chat-messages.ts'
import type { SendMessage } from '@goblin/contracts'
import { MobileConversation, type ConversationState } from './conversation.ts'
import { useOwner } from './owner.tsx'
import { Action, styles } from './ui.tsx'
import { ApiFailure } from './api.ts'

function Message({ message }: { readonly message: ChatMessage }) {
  if (message.role === 'user' || message.role === 'assistant')
    return (
      <View style={[styles.message, message.role === 'user' && styles.userMessage]}>
        <Text style={styles.role}>{message.role === 'user' ? (message.author ?? 'You') : 'goblin'}</Text>
        <Text selectable style={styles.body}>
          {message.text || (message.role === 'assistant' ? 'Using tools…' : '')}
        </Text>
      </View>
    )
  if (message.role === 'tool')
    return (
      <View style={styles.message}>
        <Text style={styles.muted}>
          {message.toolName}: {message.isError ? 'failed' : 'finished'}
        </Text>
      </View>
    )
  return (
    <View style={styles.message}>
      <Text style={styles.muted}>Open goblin on the web to view this {message.role.replaceAll('-', ' ')}.</Text>
    </View>
  )
}

export function ChatScreen({ chat }: { readonly chat: string }) {
  const { state, draft, busy, problem, pending, list, nearBottom, setDraft, send, stop } = useChat(chat)
  const projection = state.projection
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <View>
          <Text style={styles.heading}>{chat === '1' ? 'Personal' : 'Conversation'}</Text>
          <Text style={styles.muted}>{state.status}</Text>
        </View>
        {projection?.running && <Action label="Stop" onPress={() => void stop()} />}
      </View>
      <FlatList
        ref={list}
        data={projection?.messages ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <Message message={item} />}
        keyboardShouldPersistTaps="handled"
        onScroll={({ nativeEvent }) => {
          nearBottom.current =
            nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y < 100
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (nearBottom.current) list.current?.scrollToEnd({ animated: false })
        }}
        ListEmptyComponent={
          <View style={styles.message}>
            <Text style={styles.body}>What would you like to work on?</Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.message}>
            {projection?.partial !== '' && (
              <Text selectable style={styles.body}>
                {projection?.partial}
              </Text>
            )}
            {projection?.running && <Text style={styles.muted}>{projection.progress}</Text>}
            {(projection?.inbox.length ?? 0) > 0 && (
              <Text style={styles.muted}>{projection?.inbox.length} messages queued</Text>
            )}
          </View>
        }
      />
      {problem !== '' && (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.error}>
            {problem}
          </Text>
        </View>
      )}
      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Message your goblin"
          multiline
          placeholder="Message your goblin"
          maxLength={20_000}
          style={[styles.input, styles.draft]}
          value={draft}
          editable={!busy && pending.current === undefined}
          onChangeText={setDraft}
        />
        <Action
          label={busy ? 'Sending…' : pending.current ? 'Retry' : 'Send'}
          disabled={busy || draft.trim() === '' || state.signedOut === true}
          onPress={() => void send()}
        />
      </View>
    </KeyboardAvoidingView>
  )
}

function useChat(chat: string) {
  const api = useOwner()
  const [state, setState] = useState<ConversationState>({ status: 'Connecting…' })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const pending = useRef<SendMessage | undefined>(undefined)
  const list = useRef<FlatList<ChatMessage>>(null)
  const nearBottom = useRef(true)
  useEffect(() => {
    const connection = new MobileConversation(api, chat, setState)
    connection.reconnect()
    const subscription = AppState.addEventListener('change', (next) =>
      next === 'active' ? connection.reconnect() : connection.pause(),
    )
    return () => {
      subscription.remove()
      connection.pause()
    }
  }, [api, chat])
  const send = async () => {
    if (busy || draft.trim() === '') return
    const message = pending.current ?? { input: draft.trim(), operationId: crypto.randomUUID() }
    pending.current = message
    setBusy(true)
    setProblem('')
    try {
      await api.submit(chat, message)
      pending.current = undefined
      setDraft('')
    } catch (error) {
      // expected: preserve an uncertain send and its operation id for an explicit retry.
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) pending.current = undefined
      setProblem(error instanceof Error ? error.message : 'Could not send. Retry this message.')
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    try {
      await api.stop(chat)
    } catch {
      // expected: a failed Stop is visible and may be retried by the owner.
      setProblem('Could not stop the turn. Try again.')
    }
  }
  return { state, draft, busy, problem, pending, list, nearBottom, setDraft, send, stop }
}
