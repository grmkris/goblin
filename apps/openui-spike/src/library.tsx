import { lazy, Suspense, useId, useState } from 'react'
import {
  action,
  createLibrary,
  defineComponent,
  reactive,
  useIsStreaming,
  useStateField,
  useTriggerAction,
} from '@openuidev/react-lang'
import { z } from 'zod/v4'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
} from '@goblin/ui'

const Chart = lazy(() => import('@goblin/kit/chart').then((module) => ({ default: module.Chart })))
const text = z.string().max(1000)

function useLocalAction() {
  const trigger = useTriggerAction()
  const [failure, setFailure] = useState('')
  const run = (...args: Parameters<typeof trigger>) => {
    setFailure('')
    Promise.resolve()
      .then(() => trigger(...args))
      .catch(() => {
        // expected: report invalid user-edited actions in the preview without exposing interpreter internals.
        setFailure('This action could not be recorded. Reset the example and try again.')
      })
  }
  return { run, failure }
}

const Stack = defineComponent({
  name: 'Stack',
  description: 'The root: a vertical stack of up to twenty components.',
  props: z.object({ children: z.array(z.unknown()).max(20) }),
  component: ({ props, renderNode }) => <div className="flex flex-col gap-6">{renderNode(props.children)}</div>,
})

const Heading = defineComponent({
  name: 'Heading',
  description: 'A reply heading and a short explanation.',
  props: z.object({ title: text, description: text }),
  component: ({ props }) => (
    <div className="flex flex-col gap-2">
      <h2 className="text-2xl font-semibold tracking-tight text-balance">{props.title}</h2>
      <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{props.description}</p>
    </div>
  ),
})

const TextField = defineComponent({
  name: 'TextField',
  description: 'A labelled text input. Bind value to a $variable.',
  props: z.object({ name: text, label: text, value: reactive(z.string().max(500)) }),
  component: function TextFieldView({ props }) {
    const id = useId()
    const field = useStateField(props.name, props.value)
    const streaming = useIsStreaming()
    return (
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
          <Input
            id={id}
            value={field.value ?? ''}
            maxLength={500}
            disabled={streaming}
            onChange={(event) => field.setValue(event.target.value)}
          />
        </Field>
      </FieldGroup>
    )
  },
})

const NumberField = defineComponent({
  name: 'NumberField',
  description: 'A bounded number input. Bind value to a $variable.',
  props: z.object({ name: text, label: text, value: reactive(z.number()), min: z.number(), max: z.number() }),
  component: function NumberFieldView({ props }) {
    const id = useId()
    const field = useStateField(props.name, props.value)
    const streaming = useIsStreaming()
    return (
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
          <Input
            id={id}
            type="number"
            min={props.min}
            max={props.max}
            value={field.value ?? props.min}
            disabled={streaming}
            onChange={(event) => {
              const value = event.target.valueAsNumber
              if (Number.isFinite(value)) field.setValue(Math.min(props.max, Math.max(props.min, value)))
            }}
          />
        </Field>
      </FieldGroup>
    )
  },
})

const ChoiceField = defineComponent({
  name: 'ChoiceField',
  description: 'Choose a value from a short list. Bind value to a $variable.',
  props: z.object({ name: text, label: text, options: z.array(text).max(8), value: reactive(z.string()) }),
  component: function ChoiceFieldView({ props }) {
    const id = useId()
    const field = useStateField(props.name, props.value)
    const streaming = useIsStreaming()
    return (
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
          <NativeSelect
            id={id}
            value={field.value ?? ''}
            disabled={streaming}
            onChange={(event) => field.setValue(event.target.value)}
          >
            {props.options.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </FieldGroup>
    )
  },
})

const ActionButton = defineComponent({
  name: 'ActionButton',
  description: 'An explicit action, recorded locally in this spike. Use @ToAssistant(message, context).',
  props: z.object({ label: text, action: action() }),
  component: function ActionButtonView({ props }) {
    const { run: trigger, failure } = useLocalAction()
    const streaming = useIsStreaming()
    // SAFETY: OpenUI materializes action() as ActionPlan; its published schema still describes the legacy action shape.
    const plan = props.action as Parameters<typeof trigger>[2]
    return (
      <div>
        <Button disabled={streaming} onClick={() => trigger(props.label, undefined, plan)}>
          {props.label}
        </Button>
        {failure !== '' && <p role="alert">{failure}</p>}
      </div>
    )
  },
})

const Hotels = defineComponent({
  name: 'Hotels',
  description: 'Compare synthetic hotel options within the current nightly budget.',
  props: z.object({
    items: z.array(z.object({ name: text, area: text, price: z.number(), note: text, tag: text })).max(12),
    budget: z.number(),
  }),
  component: function HotelsView({ props }) {
    const { run: trigger, failure } = useLocalAction()
    const streaming = useIsStreaming()
    const stays = props.items.filter((hotel) => hotel.price <= props.budget)
    if (stays.length === 0)
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No stays in this range</EmptyTitle>
            <EmptyDescription>Raise the nightly budget to see more options.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    return (
      <div className="spike-stays">
        {failure !== '' && <p role="alert">{failure}</p>}
        {stays.map((hotel) => (
          <Card key={hotel.name} size="sm">
            <CardHeader>
              <Badge variant="secondary">{hotel.tag}</Badge>
              <CardTitle>{hotel.name}</CardTitle>
              <CardDescription>{hotel.area}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{hotel.note}</p>
              <p>
                <span className="text-2xl font-semibold tabular-nums">€{hotel.price}</span>
                <span className="text-sm text-muted-foreground"> / night</span>
              </p>
            </CardContent>
            <CardFooter>
              <Button
                variant="outline"
                disabled={streaming}
                onClick={() => {
                  trigger(`Choose ${hotel.name}`, undefined, {
                    type: 'continue_conversation',
                    params: { hotel: hotel.name, price: hotel.price },
                  })
                }}
              >
                Choose {hotel.name}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    )
  },
})

const Metrics = defineComponent({
  name: 'Metrics',
  description: 'A row of up to four summary numbers.',
  props: z.object({ items: z.array(z.object({ label: text, value: text, note: text })).max(4) }),
  component: ({ props }) => (
    <dl className="spike-metrics">
      {props.items.map((item) => (
        <div key={item.label} className="flex flex-col gap-1">
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="text-3xl font-semibold tabular-nums">{item.value}</dd>
          <dd className="text-xs text-muted-foreground">{item.note}</dd>
        </div>
      ))}
    </dl>
  ),
})

const ActivityChart = defineComponent({
  name: 'ActivityChart',
  description: 'A Goblin bar chart of tasks completed on each day.',
  props: z.object({
    title: text,
    points: z.array(z.object({ day: text, tasks: z.number().min(0).max(1000) })).max(14),
  }),
  component: ({ props }) => (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <Chart
        spec={{
          type: 'bar',
          title: props.title,
          x: 'day',
          series: [{ key: 'tasks', label: 'Tasks' }],
          data: props.points,
        }}
      />
    </Suspense>
  ),
})

const Note = defineComponent({
  name: 'Note',
  description: 'A short note calling attention to a fact.',
  props: z.object({ title: text, body: text }),
  component: ({ props }) => (
    <Alert>
      <AlertTitle>{props.title}</AlertTitle>
      <AlertDescription>{props.body}</AlertDescription>
    </Alert>
  ),
})

/** No custom functions, tool provider, remote images, links, HTML, or scripts. */
export const library = createLibrary({
  components: [Stack, Heading, TextField, NumberField, ChoiceField, ActionButton, Hotels, Metrics, ActivityChart, Note],
  root: 'Stack',
})
