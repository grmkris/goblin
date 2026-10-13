import { One, Slot } from 'one'
import { OwnerGate } from '../src/owner.tsx'
import { styles } from '../src/ui.tsx'
import { Document } from '../src/document'
export default function Layout() {
  return (
    <>
      <Document />
      <One.UI.SafeArea.View style={styles.fill}>
        <OwnerGate>
          <Slot />
        </OwnerGate>
      </One.UI.SafeArea.View>
    </>
  )
}
