import { lazy, Suspense, useId } from 'react'
import { createLibrary, defineComponent, reactive, useIsStreaming, useStateField } from '@openuidev/react-lang'
import { z } from 'zod/v4'
import { chartSpec } from '@goblin/kit'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
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
            name={props.label}
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
            name={props.label}
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
            name={props.label}
            value={field.value ?? ''}
            disabled={streaming}
            onChange={(event) => field.setValue(event.target.value)}
          >
            {props.options.map((option, index) => (
              <NativeSelectOption key={index} value={option}>
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
  description: 'Sends its visible label and the visible form values as an owner follow-up. No hidden action.',
  props: z.object({ label: text.min(1).max(200) }),
  component: ({ props }) => (
    <Button type="submit" value={props.label}>
      {props.label}
    </Button>
  ),
})

const Cards = defineComponent({
  name: 'Cards',
  description: 'Compare up to eight options. Each button sends its visible label as a follow-up.',
  props: z.object({
    items: z.array(z.object({ title: text, description: text, detail: text, label: text.min(1).max(200) })).max(8),
  }),
  component: ({ props }) => (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
      {props.items.map((item, index) => (
        <Card key={index} size="sm">
          <CardHeader>
            <CardTitle>{item.title}</CardTitle>
            <CardDescription>{item.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <p>{item.detail}</p>
          </CardContent>
          <CardFooter>
            <Button type="submit" variant="outline" value={item.label}>
              {item.label}
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  ),
})

const Metrics = defineComponent({
  name: 'Metrics',
  description: 'A row of up to four summary numbers.',
  props: z.object({ items: z.array(z.object({ label: text, value: text, note: text })).max(4) }),
  component: ({ props }) => (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-4">
      {props.items.map((item, index) => (
        <div key={index} className="flex flex-col gap-1">
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="text-3xl font-semibold tabular-nums">{item.value}</dd>
          <dd className="text-xs text-muted-foreground">{item.note}</dd>
        </div>
      ))}
    </dl>
  ),
})

const ReplyChart = defineComponent({
  name: 'Chart',
  description: 'A chart using the same JSON spec as a chart fence, encoded as a string.',
  props: z.object({ spec: z.string().max(12000) }),
  component: function ChartView({ props }) {
    const spec = chartSpec(props.spec)
    if (spec === undefined) throw new Error('Invalid reply chart')
    return (
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <Chart spec={spec} />
      </Suspense>
    )
  },
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
const components = [Stack, Heading, TextField, NumberField, ChoiceField, ActionButton, Cards, Metrics, ReplyChart, Note]

/** Concrete schemas retained independently of OpenUI's type-erased component registry. */
export const componentSchemas: ReadonlyMap<string, z.ZodObject> = new Map(
  components.map(({ name, props }) => [name, props]),
)

export const library = createLibrary({
  components,
  root: 'Stack',
})
