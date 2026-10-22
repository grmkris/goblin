import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/** One webhook as the receiver took it: where, its signing headers, its exact body, what it answered and when. */
export type Received = {
  readonly url: string
  readonly webhookId: string
  readonly timestamp: string
  readonly signature: string
  readonly subscriptionId: string
  readonly body: string
  readonly status: number
  readonly at: number
}

const Challenge = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal('verification'), challenge: Schema.String }),
)

/**
 * The integration harness's webhook receiver for the Events goblin publishes (ADR 0112), behind the agent's
 * `publishFetch` port: it keeps every POST as sent and answers a challenge with its echo; a URL ending `/failing`
 * answers every other webhook 500, any other 204. It checks nothing itself: the case verifies what it kept.
 */
export class PublishReceiver {
  readonly received: Received[] = []
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request = new Request(url, init)
    const body = await request.text()
    const challenge = Option.getOrUndefined(Schema.decodeUnknownOption(Challenge)(body))
    const answer =
      challenge !== undefined
        ? Response.json({ challenge: challenge.challenge })
        : new Response(null, { status: new URL(url).pathname.endsWith('/failing') ? 500 : 204 })
    this.received.push({
      url,
      webhookId: request.headers.get('webhook-id') ?? '',
      timestamp: request.headers.get('webhook-timestamp') ?? '',
      signature: request.headers.get('webhook-signature') ?? '',
      subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
      body,
      status: answer.status,
      at: Date.now(),
    })
    return answer
  }
}
