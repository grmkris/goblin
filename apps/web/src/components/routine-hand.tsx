// What a routine does when it fires (ADR 0041), as its editor asks it: where it lives and posts, whether it tells the
// owner (and sends each notification on through Notify me via, ADR 0070), and whom it hands the work to — nobody,
// Goblin, or a Persona — with the instruction, the tools and the limits a hand-over carries.
import { useQuery } from '@tanstack/react-query'
import type { PersonaView, RoutineHandOver, TopicView } from '@goblin/contracts'
import {
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@goblin/ui'
import { notifySinkQuery } from '../notify/queries.ts'
import { EditorPart } from './editor-part.tsx'

type Tool = { readonly connectionId: string; readonly name: string }

/** Whom a routine hands its work to, as the editor picks it. */
export type HandKind = 'none' | 'goblin' | 'persona'

/** What these parts read from the editor and change in it. */
export type HandKit = {
  readonly id: string
  readonly handOver: RoutineHandOver
  readonly topics: readonly TopicView[]
  readonly topic: number
  readonly setTopic: (topic: number) => void
  readonly tellMe: boolean
  readonly setTellMe: (on: boolean) => void
  readonly copy: boolean
  readonly setCopy: (on: boolean) => void
  readonly hand: HandKind
  readonly setHand: (hand: HandKind) => void
  readonly personas: readonly PersonaView[]
  readonly persona: number | undefined
  readonly setPersona: (persona: number | undefined) => void
  readonly available: readonly Tool[]
  readonly selected: readonly Tool[]
  readonly toggle: (tool: Tool, on: boolean) => void
}

const same = (a: Tool, b: Tool): boolean => a.connectionId === b.connectionId && a.name === b.name

/** The Topic a routine lives in: it posts its notices and answers there, and its runs work within its setup. */
export function WhereField({ kit }: { readonly kit: HandKit }) {
  const { id, topics, topic, setTopic } = kit
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-topic`}>Topic</FieldLabel>
      <NativeSelect id={`${id}-topic`} value={String(topic)} onChange={(event) => setTopic(Number(event.target.value))}>
        {topics.map((each) => (
          <NativeSelectOption key={each.id} value={String(each.id)}>
            #{each.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>It posts there, and what it hands over works within that Topic's setup.</FieldDescription>
    </Field>
  )
}

/** One switch row: its words, and the switch they name (also the event picker's Advanced). */
export function SwitchRow({
  id,
  name,
  about,
  checked,
  disabled = false,
  onChange,
}: {
  readonly id: string
  readonly name: string
  readonly about: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (on: boolean) => void
}) {
  return (
    <li className="setting-row">
      <span className="grant-text">
        <span id={id} className="grant-name">
          {name}
        </span>
        <span className="grant-about">{about}</span>
      </span>
      <Switch checked={checked} disabled={disabled} aria-labelledby={id} onCheckedChange={onChange} />
    </li>
  )
}

/**
 * "Also send to <where>": each notification sent on through Notify me via too (ADR 0070), named by its connection's
 * label; off, with a hint, while the owner has set none (a copy already asked for can still be turned off). Also the
 * event picker's Advanced.
 */
export function CopyRow({
  id,
  told,
  checked,
  onChange,
}: {
  readonly id: string
  readonly told: boolean
  readonly checked: boolean
  readonly onChange: (on: boolean) => void
}) {
  const sink = useQuery(notifySinkQuery).data
  const label = sink?.label
  return (
    <SwitchRow
      id={`${id}-copy`}
      name={label === undefined ? 'Also send elsewhere' : `Also send to ${label}`}
      about={
        label === undefined
          ? 'Set Notify me via in Settings to send each notification on.'
          : 'Each notification, through Notify me via in Settings.'
      }
      checked={told && checked}
      disabled={!told || (label === undefined && !checked)}
      onChange={onChange}
    />
  )
}

/** Tell me: every post of the routine is a notification in Activity, and sent on through Notify me via if wanted. */
export function TellMeFields({ kit }: { readonly kit: HandKit }) {
  const { id, tellMe, setTellMe, copy, setCopy } = kit
  return (
    <EditorPart title="Tell me">
      <ul className="grant-list">
        <SwitchRow
          id={`${id}-tell-me`}
          name="Tell me"
          about="Each event it sees, and each answer, is a notification in Activity."
          checked={tellMe}
          onChange={(on) => {
            setTellMe(on)
            if (!on) setCopy(false)
          }}
        />
        <CopyRow id={id} told={tellMe} checked={copy} onChange={setCopy} />
      </ul>
    </EditorPart>
  )
}

/** The tools a hand-over may call: those the owner allowed, plus any the routine already names. */
function ToolRows({ kit }: { readonly kit: HandKit }) {
  const { id, available, selected, toggle } = kit
  if (available.length === 0)
    return <p className="server-note">You have allowed no tools yet, so it can only answer.</p>
  return (
    <ul className="grant-list">
      {available.map((tool) => (
        <SwitchRow
          key={`${tool.connectionId}:${tool.name}`}
          id={`${id}-${tool.connectionId}-${tool.name}`}
          name={tool.name}
          about={tool.connectionId}
          checked={selected.some((item) => same(item, tool))}
          onChange={(on) => toggle(tool, on)}
        />
      ))}
    </ul>
  )
}

const LIMITS = [
  { name: 'tokensPerRun', label: 'Tokens a run', max: 100_000 },
  { name: 'tokensPerDay', label: 'Tokens a day', max: 2_000_000 },
  { name: 'runtimeMinutes', label: 'Minutes at most', max: 30 },
] as const

/** A hand-over's limits, side by side. */
function Limits({ kit }: { readonly kit: HandKit }) {
  const { id, handOver } = kit
  const value = (name: (typeof LIMITS)[number]['name']) =>
    name === 'runtimeMinutes' ? Math.max(1, Math.round(handOver.budget.runtimeSeconds / 60)) : handOver.budget[name]
  return (
    <div className="editor-limits">
      {LIMITS.map((limit) => (
        <Field key={limit.name}>
          <FieldLabel htmlFor={`${id}-${limit.name}`}>{limit.label}</FieldLabel>
          <Input
            id={`${id}-${limit.name}`}
            name={limit.name}
            type="number"
            inputMode="numeric"
            min={1}
            max={limit.max}
            defaultValue={value(limit.name)}
            required
          />
        </Field>
      ))}
    </div>
  )
}

/** The Persona a hand-over goes to: the active ones, by name. */
function PersonaField({ kit }: { readonly kit: HandKit }) {
  const { id, personas, persona, setPersona } = kit
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-persona`}>Persona</FieldLabel>
      <NativeSelect
        id={`${id}-persona`}
        value={persona === undefined ? '' : String(persona)}
        onChange={(event) => setPersona(event.target.value === '' ? undefined : Number(event.target.value))}
        required
      >
        <NativeSelectOption value="">Choose one</NativeSelectOption>
        {personas.map((each) => (
          <NativeSelectOption key={each.id} value={String(each.id)}>
            @{each.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>It answers as it is now; if you change it later, confirm this routine again.</FieldDescription>
    </Field>
  )
}

/** What a routine handed to nobody does: it tells the owner, or with Tell me off nothing yet, and what would change that. */
export const nobodyNote = (tellMe: boolean): string =>
  tellMe ? 'It only tells you.' : 'It does nothing yet. Turn Tell me on, or hand it over.'

/** Hand to: nobody, goblin or a Persona; a hand-over says what to do, then with which tools, within which limits. */
export function HandToFields({ kit }: { readonly kit: HandKit }) {
  const { id, hand, setHand, handOver } = kit
  return (
    <>
      <EditorPart title="Hand to">
        <Tabs value={hand} onValueChange={(value: HandKind) => setHand(value)}>
          <TabsList>
            <TabsTrigger value="none">Nobody</TabsTrigger>
            <TabsTrigger value="goblin">goblin</TabsTrigger>
            <TabsTrigger value="persona" disabled={kit.personas.length === 0}>
              A Persona
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {hand === 'none' ? (
          <p className="server-note">{nobodyNote(kit.tellMe)}</p>
        ) : (
          <>
            {hand === 'persona' && <PersonaField kit={kit} />}
            <Field>
              <FieldLabel htmlFor={`${id}-prompt`}>Instructions</FieldLabel>
              <Textarea
                id={`${id}-prompt`}
                name="prompt"
                defaultValue={handOver.instruction}
                maxLength={12_000}
                required
              />
              <FieldDescription>What should be done each time, in your own words.</FieldDescription>
            </Field>
          </>
        )}
      </EditorPart>
      {hand !== 'none' && (
        <EditorPart title="Tools and limits">
          <ToolRows kit={kit} />
          <Limits kit={kit} />
        </EditorPart>
      )}
    </>
  )
}
