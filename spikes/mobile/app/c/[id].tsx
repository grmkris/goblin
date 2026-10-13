import { useParams } from 'one'
import { ChatId } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { Text, View } from 'react-native'
import { ChatScreen } from '../../src/chat-screen.tsx'
import { styles } from '../../src/ui.tsx'
export default function Conversation() {
  const { id } = useParams<{ id: string }>()
  if (!Schema.is(ChatId)(id))
    return (
      <View style={styles.page}>
        <Text style={styles.body}>Invalid conversation link.</Text>
      </View>
    )
  return <ChatScreen key={id} chat={id ?? '1'} />
}
