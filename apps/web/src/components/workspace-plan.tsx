import { useMutation, useQuery } from '@tanstack/react-query'
import type { TopicView, WorkspacePlanItem, WorkspacePlanView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  JsonView,
  Skeleton,
  ToolPayload,
} from '@goblin/ui'
import { CheckCircle2Icon, ChevronRightIcon, CircleIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import { setupFacts } from '../lib/source-setup.ts'
import { newKeysWords } from '../lib/source-routes.ts'
import {
  applyWorkspacePlanMutation,
  prepareWorkspacePlanMutation,
  workspacePlanQuery,
} from '../workspace-plans/queries.ts'

const labels: Readonly<Record<WorkspacePlanView['state'], string>> = {
  preparing: 'Preparing',
  proposed: 'Ready to review',
  applying: 'Applying',
  ready: 'Configured',
  attention: 'Needs attention',
}

/** A Source's direction or a routine's trigger, without loading a second live configuration. */
function descriptionOf(item: WorkspacePlanItem): string {
  if (item.kind === 'source')
    return `${item.source.label} · ${item.source.setup.reply === undefined ? 'Receive messages' : 'Receive messages and reply'}`
  const { trigger, timezone } = item.routine.definition
  if (trigger.kind === 'once') return `Once · ${trigger.at}`
  if (trigger.kind === 'cron') return `${trigger.expression} · ${timezone}`
  return `On ${trigger.name}`
}

/** A readable summary of an exact stored primitive; the complete definition remains inspectable. */
function PlanItem({
  item,
  topics,
  completed,
}: {
  readonly item: WorkspacePlanItem
  readonly topics: readonly TopicView[]
  readonly completed: boolean
}) {
  const title = item.kind === 'source' ? item.source.title : item.routine.definition.title
  const definition = item.kind === 'source' ? item.source.setup : item.routine.definition
  const Icon = completed ? CheckCircle2Icon : CircleIcon
  return (
    <li className="flex min-w-0 gap-3">
      <Icon className="mt-1 size-4 shrink-0" aria-label={completed ? 'Configured' : 'Awaiting activation'} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="font-medium break-words">{title}</p>
        <p className="text-muted-foreground text-sm break-words">{descriptionOf(item)}</p>
        {item.kind === 'source' && (
          <dl className="routine-facts">
            {setupFacts(item.source.setup, {
              event: item.source.setup.wake.event,
              newKeys: (route) => newKeysWords(route, topics, []),
            })
              .filter((fact) => ['You speak', 'Others', 'New conversations'].includes(fact.term))
              .map((fact) => (
                <div key={fact.term}>
                  <dt>{fact.term}</dt>
                  <dd>{fact.text}</dd>
                </div>
              ))}
          </dl>
        )}
        {item.kind === 'routine' && (
          <p className="text-sm break-words">
            In #{topics.find((topic) => topic.id === item.routine.topic)?.name ?? String(item.routine.topic)}
            {item.routine.definition.handTo.kind === 'none'
              ? ' · Reminder only'
              : ` · ${item.routine.definition.handTo.instruction}`}
          </p>
        )}
        <Collapsible>
          <CollapsibleTrigger render={<button type="button" className="event-advanced-toggle" />}>
            <ChevronRightIcon aria-hidden /> Exact settings
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ToolPayload label="Exact settings" raw={JSON.stringify(definition, null, 2)} view="tree">
              <JsonView value={definition} initialDepth={1} />
            </ToolPayload>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  )
}

/** A setup's native authority controls. The browser projects the stored plan and never executes its steps. */
export function WorkspacePlanCard({ id }: { readonly id: string }) {
  const read = useQuery(workspacePlanQuery(id))
  const apply = useMutation(applyWorkspacePlanMutation)
  const prepare = useMutation(prepareWorkspacePlanMutation)
  const plan = read.data
  const error = apply.error ?? prepare.error ?? read.error
  return (
    <Card>
      <CardHeader>
        <CardTitle>{plan?.title ?? 'Your setup'}</CardTitle>
        <CardDescription>{plan?.purpose ?? 'Reading the setup Goblin prepared…'}</CardDescription>
        {plan && <Badge variant="secondary">{labels[plan.state]}</Badge>}
      </CardHeader>
      <CardContent>
        <PlanBody plan={plan} error={error} pending={read.isPending} />
      </CardContent>
      <CardFooter>
        <PlanActions
          plan={plan}
          fetching={read.isFetching}
          applying={apply.isPending}
          preparing={prepare.isPending}
          onApply={(revision) => apply.mutate({ id, revision })}
          onPrepare={(revision) => prepare.mutate({ id, revision })}
          onRefresh={() => void read.refetch()}
        />
      </CardFooter>
    </Card>
  )
}

function PlanBody({
  plan,
  error,
  pending,
}: {
  readonly plan: WorkspacePlanView | undefined
  readonly error: unknown
  readonly pending: boolean
}) {
  return (
    <div className="flex flex-col gap-4">
      {!plan && pending && <Skeleton className="h-24 w-full" />}
      {plan && (
        <>
          <ul className="flex flex-col gap-5" aria-label="Setup steps">
            {plan.items.map((item, index) => (
              <PlanItem
                key={item.kind === 'source' ? item.source.id : item.routine.id}
                item={item}
                topics={plan.topics}
                completed={plan.completed.includes(index)}
              />
            ))}
          </ul>
          <p className="text-muted-foreground text-sm">
            {plan.state === 'ready'
              ? plan.continuation === 'kept'
                ? 'Configuration is active. Goblin will read the result on your next message.'
                : 'Configuration is active. Check a real message or scheduled run to verify it works.'
              : 'Activating confirms these exact Sources and routines, including their event subscriptions and tool access. Tools set to Ask first still ask.'}
          </p>
          {plan.state === 'attention' && (
            <Alert>
              <AlertDescription>
                Some steps need attention. Completed steps are kept; retry continues the remaining setup.
              </AlertDescription>
            </Alert>
          )}
          {plan.state === 'preparing' && (
            <Alert>
              <AlertDescription>
                The review is not ready. Retry preparation after connecting any missing services or allowing the
                requested tools. Nothing is activated. If the setup needs changes, ask Goblin to propose it again.
                {plan.problem && ` (${plan.problem})`}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{messageOf(error, 'apply the setup')}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function PlanActions({
  plan,
  fetching,
  applying,
  preparing,
  onApply,
  onPrepare,
  onRefresh,
}: {
  readonly plan: WorkspacePlanView | undefined
  readonly fetching: boolean
  readonly applying: boolean
  readonly preparing: boolean
  readonly onApply: (revision: number) => void
  readonly onPrepare: (revision: number) => void
  readonly onRefresh: () => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {plan?.state === 'preparing' && (
        <Button pending={preparing} disabled={fetching} onClick={() => onPrepare(plan.revision)}>
          Retry preparation
        </Button>
      )}
      {plan && (plan.state !== 'ready' || plan.continuation === 'pending') && plan.state !== 'preparing' && (
        <Button pending={applying} disabled={fetching} onClick={() => onApply(plan.revision)}>
          {plan.state === 'proposed' ? 'Activate setup' : 'Continue setup'}
        </Button>
      )}
      <Button variant="outline" pending={fetching} disabled={applying || preparing} onClick={onRefresh}>
        Refresh status
      </Button>
    </div>
  )
}
