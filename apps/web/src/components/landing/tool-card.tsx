// The landing's picture of a connection's tools as goblin lists them (`components/tool-grants.tsx`, in its classes):
// mysi, the owner's own apps in one connection, with four of its tools by their own titles, each with its switch and,
// once allowed, whether it runs or asks first. The switches work, on this page only: nothing here reaches a server.
import { useId, useState } from 'react'
import { BlocksIcon } from 'lucide-react'
import { NativeSelect, NativeSelectOption, Switch } from '@goblin/ui'

type Policy = 'off' | 'run' | 'ask'

interface Tool {
  readonly name: string
  readonly title: string
  readonly about: string
  readonly policy: Policy
}

/** mysi's tools as it titles them, with a shortened description, and how the picture starts: one off, one asks. */
const TOOLS: readonly Tool[] = [
  { name: 'myplan_note_read', title: 'Read a note', about: 'Read a note as Markdown.', policy: 'run' },
  {
    name: 'myinbox_message_search',
    title: 'Search messages',
    about: 'Search mail by sender, subject and body.',
    policy: 'run',
  },
  {
    name: 'myinbox_message_send',
    title: 'Send a message',
    about: 'Send mail from one of your addresses.',
    policy: 'ask',
  },
  {
    name: 'mytab_browser_open',
    title: 'Open a browser',
    about: 'Start a browser on a machine or in the cloud.',
    policy: 'off',
  },
]

export function ToolCard() {
  const [policies, setPolicies] = useState<Readonly<Record<string, Policy>>>(() =>
    Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.policy])),
  )
  const set = (name: string, policy: Policy) => setPolicies((current) => ({ ...current, [name]: policy }))
  const allowed = TOOLS.filter((tool) => policies[tool.name] !== 'off').length
  return (
    <figure className="landing-tools">
      <div className="landing-tools-card">
        <div className="landing-tools-head">
          <span aria-hidden className="landing-tools-tile">
            <BlocksIcon />
          </span>
          <span className="landing-tools-name">mysi</span>
          <span
            className="grant-count"
            role="status"
          >{`${String(allowed)} of ${String(TOOLS.length)} tools allowed`}</span>
        </div>
        <ul className="landing-tools-list">
          {TOOLS.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              policy={policies[tool.name] ?? tool.policy}
              onChange={(policy) => set(tool.name, policy)}
            />
          ))}
        </ul>
      </div>
      <figcaption>A connection&rsquo;s tools in goblin. The switches work here too.</figcaption>
    </figure>
  )
}

/** One tool, its switch, and once it is allowed whether it runs or asks first; allowing one again lets it run. */
function ToolRow({
  tool,
  policy,
  onChange,
}: {
  readonly tool: Tool
  readonly policy: Policy
  readonly onChange: (policy: Policy) => void
}) {
  const id = useId()
  return (
    <li className="grant-row">
      <span className="grant-text">
        <span id={id} className="grant-name">
          {tool.title}
        </span>
        <span className="grant-about">{tool.about}</span>
      </span>
      {policy !== 'off' && (
        <NativeSelect
          size="sm"
          aria-label={`When ${tool.title} is called`}
          value={policy}
          onChange={(event) => onChange(event.target.value === 'ask' ? 'ask' : 'run')}
        >
          <NativeSelectOption value="run">Runs without asking</NativeSelectOption>
          <NativeSelectOption value="ask">Asks you first</NativeSelectOption>
        </NativeSelect>
      )}
      <Switch
        checked={policy !== 'off'}
        aria-labelledby={id}
        onCheckedChange={(checked) => onChange(checked ? 'run' : 'off')}
      />
    </li>
  )
}
