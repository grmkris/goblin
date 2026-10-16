import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { Button } from '@goblin/ui'
import { ChatMarkdown } from '../../src/components/parts/markdown.tsx'
import { ReplySend } from '../../src/components/parts/openui/context.ts'
import { Cause } from '../../src/components/parts/text-part.tsx'
import { useConversation } from '../../src/components/use-conversation.ts'
import { makeQueryClient } from '../../src/lib/query/api-query.ts'
import '../../src/styles.css'

const SOURCE = `root = Stack([Heading("A weekend away", "Choose the details"), city, days, pace, send])
$city = "Lisbon"
$days = 3
$pace = "Slow"
city = TextField("city", "Destination", $city)
days = NumberField("days", "Days away", $days, 1, 14)
pace = ChoiceField("pace", "Pace", ["Slow", "Busy"], $pace)
send = ActionButton("Plan my weekend")`
// Several buttons, so Enter in a field must not choose one; a long label must wrap whole; a wide number range.
const CHOICES = `root = Stack([stays, notes, budget, send])
$notes = ""
$budget = 300
stays = Cards([{title: "Casa do Jardim", description: "Príncipe Real", detail: "A leafy courtyard.", label: "Choose Casa do Jardim, the quiet one with the leafy courtyard and the small breakfast room by the park"}, {title: "Alfama House", description: "Alfama", detail: "River views.", label: "Choose Alfama House"}])
notes = TextField("notes", "Anything else?", $notes)
budget = NumberField("budget", "Budget per night", $budget, 100, 5000)
send = ActionButton("Send my notes")`
const fence = (source: string) => `\`\`\`openui\n${source}\n\`\`\``

/** The production send hook and Markdown path, with HTTP intercepted by the browser acceptance script. */
function Fixture() {
  const chat = useConversation('101', false)
  const other = useConversation('202', false)
  const [closed, setClosed] = useState(false)
  const [live, setLive] = useState(true)
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-4">
      <Button onClick={() => setClosed(!closed)}>{closed ? 'Reopen chat' : 'Close chat'}</Button>
      <ReplySend value={closed ? undefined : chat.send}>
        <section aria-label="Owner reply">
          <ChatMarkdown text={fence(SOURCE) + (live ? '' : '\n\nDone.')} live={live} />
        </section>
        <section aria-label="Choice reply">
          <ChatMarkdown text={fence(CHOICES)} live={false} />
        </section>
        <section aria-label="Quoted reply">
          <Cause icon={null} line="Shared from another chat" text={fence(SOURCE)} />
        </section>
        <section aria-label="Streaming reply">
          <ChatMarkdown text={live ? '```openui\n' + SOURCE : fence(SOURCE)} live={live} />
        </section>
        <Button onClick={() => setLive(false)}>Finish reply</Button>
        <section aria-label="Invalid reply">
          <ChatMarkdown text={fence('root = Stack([Unknown("oops")])')} live={false} />
        </section>
        <section aria-label="Invalid chart">
          <ChatMarkdown text={fence('root = Stack([Chart("invalid")])')} live={false} />
        </section>
        <section aria-label="Inert text">
          <ChatMarkdown
            text={fence('root = Stack([Heading("<img src=https://example.com/x>", "<script>alert(1)</script>")])')}
            live={false}
          />
        </section>
        <ReplySend value={other.send}>
          <section aria-label="Other chat">
            <ChatMarkdown text={fence('root = Stack([ActionButton("Ask in the other chat")])')} live={false} />
          </section>
        </ReplySend>
      </ReplySend>
    </main>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('Missing fixture root')
createRoot(root).render(
  <QueryClientProvider client={makeQueryClient()}>
    <Fixture />
  </QueryClientProvider>,
)
