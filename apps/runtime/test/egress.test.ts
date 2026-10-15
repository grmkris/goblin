import { describe, expect, it } from 'vitest'
import { egress } from '../src/agent-apps/egress.ts'

/** The internet as an app's fetch reaches it: it answers every request and keeps the URLs it was sent. */
const internet = () => {
  const sent: string[] = []
  const send = async (url: URL) => {
    sent.push(url.href)
    return new Response('ok')
  }
  return { sent, send }
}

describe("an app's fetch and the deployment's own host (unit)", () => {
  const policy = { approved: () => true, appUrl: 'https://goblin.example.workers.dev' }

  it('refuses the deployment itself and anything under it', async () => {
    const { sent, send } = internet()
    for (const target of ['https://goblin.example.workers.dev/api/agent', 'https://x.goblin.example.workers.dev/'])
      await expect(egress(send, target, {}, policy)).rejects.toThrow('does not reach goblin itself')
    expect(sent).toEqual([])
  })

  it("reaches a neighbour on the same platform domain, which is not goblin's", async () => {
    const { sent, send } = internet()
    expect(await egress(send, 'https://weather.example.workers.dev/now', {}, policy)).toMatchObject({ status: 200 })
    expect(sent).toEqual(['https://weather.example.workers.dev/now'])
  })
})
