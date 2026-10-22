import * as Schema from 'effect/Schema'
import { ChatId } from '../ids.ts'
import { NoticeData } from '../notices.ts'
import { DelegateResultData, ThreadHeadData } from '../threads.ts'
import { TopicSeedData } from '../topics.ts'

/**
 * goblin's activity types: the entries the app draws itself, sent as `ACTIVITY_SNAPSHOT` live and as `activity`
 * messages in `MESSAGES_SNAPSHOT` (never as CUSTOM events, which a reader that joins later never sees). Each content is
 * the entry's data as its contract says.
 *
 * - `goblin.thread_head`: a Thread started here (ADR 0034); its head text and the Thread it links.
 * - `goblin.thread_started`: a "+" thread was started from here (its title is in the Thread itself).
 * - `goblin.notice`: a routine's notice (ADR 0041), the producer's words.
 * - `goblin.topic_seed`: the brief and frozen sources a new Topic started with (ADR 0032).
 * - `goblin.delegate_result`: a Delegate's attributed result in the chat that assigned it (ADR 0033).
 */
export const ActivityType = {
  threadHead: 'goblin.thread_head',
  threadStarted: 'goblin.thread_started',
  notice: 'goblin.notice',
  topicSeed: 'goblin.topic_seed',
  delegateResult: 'goblin.delegate_result',
} as const

/** `goblin.thread_started`'s content: the thread the owner started with "+". */
export const ThreadStartedData = Schema.Struct({ thread: ChatId })

/** One goblin activity: its type and the content that type carries. */
export const GoblinActivity = Schema.Union([
  Schema.Struct({ activityType: Schema.Literal(ActivityType.threadHead), content: ThreadHeadData }),
  Schema.Struct({ activityType: Schema.Literal(ActivityType.threadStarted), content: ThreadStartedData }),
  Schema.Struct({ activityType: Schema.Literal(ActivityType.notice), content: NoticeData }),
  Schema.Struct({ activityType: Schema.Literal(ActivityType.topicSeed), content: TopicSeedData }),
  Schema.Struct({ activityType: Schema.Literal(ActivityType.delegateResult), content: DelegateResultData }),
])
export type GoblinActivity = typeof GoblinActivity.Type
