import { Pressable, StyleSheet, Text } from 'react-native'

export function Action({
  label,
  onPress,
  disabled = false,
  quiet = false,
}: {
  readonly label: string
  readonly onPress: () => void
  readonly disabled?: boolean
  readonly quiet?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [quiet ? styles.quiet : styles.button, { opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}
    >
      <Text style={quiet ? styles.link : styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

export const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#f6f7f4' },
  page: { flex: 1, padding: 24, gap: 16, backgroundColor: '#f6f7f4', justifyContent: 'center' },
  form: { width: '100%', maxWidth: 420, alignSelf: 'center', gap: 16 },
  wordmark: { color: '#f6f7f4', fontSize: 24, fontWeight: '700' },
  title: { color: '#273e31', fontSize: 32, fontWeight: '700', lineHeight: 38 },
  heading: { color: '#273e31', fontSize: 24, fontWeight: '600' },
  body: { color: '#354c3e', fontSize: 17, lineHeight: 25 },
  muted: { color: '#54645b', fontSize: 14, lineHeight: 21 },
  input: {
    borderColor: '#a1aea3',
    borderWidth: 1,
    borderRadius: 10,
    color: '#273e31',
    backgroundColor: '#ffffff',
    fontSize: 17,
    padding: 14,
    minHeight: 50,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#314d3c',
    borderRadius: 10,
    paddingHorizontal: 18,
    minHeight: 48,
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  quiet: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  link: { color: '#dfeadb', fontSize: 16 },
  error: { color: '#9d3429', fontSize: 15, lineHeight: 22 },
  account: {
    backgroundColor: '#314d3c',
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#c8d1c7',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  message: { paddingVertical: 12, paddingHorizontal: 20, gap: 4 },
  userMessage: { backgroundColor: '#eaf0e6' },
  role: { color: '#354c3e', fontSize: 14, fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-end',
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#c8d1c7',
  },
  draft: { flex: 1, maxHeight: 150, minHeight: 48 },
  notice: { paddingHorizontal: 20, paddingVertical: 6 },
})
