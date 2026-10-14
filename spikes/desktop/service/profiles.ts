import { Fixture } from './fixture'
import { Live } from './live'
import { events } from './events'
import { hosts, type Command, type HostName, type ViewState } from '../shared/src/types'

type Profile = { fixture: Fixture; live: Live; mode: 'fixture' | 'live'; busy: boolean; revision: number }
export class Profiles {
  #profiles = new Map<HostName, Profile>()
  #listeners = new Map<HostName, Set<(data: string) => void>>()
  constructor(origin: string, fetcher?: typeof fetch) {
    for (const host of hosts) {
      this.#listeners.set(host, new Set())
      const publish = () => this.#publish(host)
      this.#profiles.set(host, {
        fixture: new Fixture(publish),
        live: new Live(origin, publish, fetcher),
        mode: 'fixture',
        busy: false,
        revision: 0,
      })
    }
  }
  #profile(host: HostName): Profile {
    const profile = this.#profiles.get(host)
    if (!profile) throw new Error('Unknown profile')
    return profile
  }
  view(host: HostName): ViewState {
    const p = this.#profile(host)
    return { ...(p.mode === 'fixture' ? p.fixture.view() : p.live.view()), revision: p.revision }
  }
  #publish(host: HostName) {
    this.#profile(host).revision++
    for (const send of this.#listeners.get(host) ?? []) send(`data: ${JSON.stringify(this.view(host))}\n\n`)
  }
  events(host: HostName): Response {
    const clients = this.#listeners.get(host)
    if (!clients) throw new Error('Unknown profile')
    return events(`data: ${JSON.stringify(this.view(host))}\n\n`, clients)
  }
  async command(host: HostName, command: Command): Promise<ViewState> {
    const p = this.#profile(host)
    if (p.busy) throw new Error('A command is already in progress')
    p.busy = true
    try {
      if (command.type === 'mode') await this.#mode(host, command.mode)
      else if (p.mode === 'fixture') p.fixture.command(command)
      else await p.live.command(command)
      return this.view(host)
    } finally {
      p.busy = false
    }
  }
  async #mode(host: HostName, mode: 'fixture' | 'live') {
    const p = this.#profile(host)
    if (p.live.view().pendingOperation) throw new Error('Retry the uncertain message or sign out before changing mode')
    p.fixture.dispose()
    p.live.dispose()
    p.mode = mode
    this.#publish(host)
    if (mode === 'live' && p.live.view().signedIn) await p.live.command({ type: 'reconnect' })
  }
  dispose() {
    for (const p of this.#profiles.values()) {
      p.fixture.dispose()
      p.live.dispose()
    }
  }
}
