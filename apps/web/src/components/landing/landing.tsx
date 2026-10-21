// goblin's public front door at `/` for a visitor who is signed out (a signed-in person's workspace opens instead):
// what goblin does differently, in ten seconds, that it is real (open source), and the way in, Meet your goblin. The
// hero is goblin's own shell at large scale with a short session playing in it; everything after it is quiet: a
// heading, a little copy and one real visual per section. Built from the shared marketing parts in @goblin/ui.
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { GoblinMark, MossFrame, Section, SiteBar, SiteButton, SiteFooter, type SiteLink } from '@goblin/ui'
import { HeroComposer, HeroSession, HeroStatus, useHeroSession } from './hero-session.tsx'
import { ServerList } from './server-list.tsx'
import lisbonDark from '../../assets/landing/lisbon-dark.webp'
import lisbonLight from '../../assets/landing/lisbon-light.webp'
import lisbonPhoneDark from '../../assets/landing/lisbon-phone-dark.webp'
import trivagoApp from '../../assets/landing/trivago-app.webp'

/** goblin's public homes: its source on GitHub and its account on X. */
const ELSEWHERE = { github: 'https://github.com/grmkris/goblin', x: 'https://x.com/goblin_surf' } as const

const MEET = { label: 'Meet your goblin', href: '/login?new=1' } as const satisfies SiteLink
const SIGN_IN = { label: 'Sign in', href: '/login' } as const satisfies SiteLink

/**
 * This deployment's own origin: the page's in the browser, and while rendered on the server the one its route read
 * from the request (`lib/origin.ts`, ADR 0064), so both say the same.
 */
const useOrigin = (rendered: string | undefined): string =>
  useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => rendered ?? '',
  )

/** The landing, with `origin` the deployment's own as its route read it (for the server's render). */
export function Landing({ origin }: { readonly origin?: string | undefined } = {}) {
  const session = useHeroSession()
  return (
    <>
      <SiteBar
        name="goblin"
        mark={<GoblinMark />}
        tone="moss"
        links={[{ label: 'GitHub', href: ELSEWHERE.github, external: true }]}
        signIn={SIGN_IN}
        cta={MEET}
      />
      <MossFrame
        title="Your own goblin, always on."
        lede="A personal agent that keeps working while you're away, uses only the tools you allow, and asks before it acts."
        actions={<SiteButton action={MEET} />}
        note="Open source. Bring your own model."
        panelLabel="# Islands"
        panelStatus={<HeroStatus stage={session.stage} />}
        panel={<HeroSession session={session} />}
        panelFooter={<HeroComposer />}
      />
      <Away />
      <Connect />
      <Open origin={origin} />
      <Close />
      <SiteFooter
        name="goblin"
        mark={<GoblinMark />}
        note="Your own resident agent on Cloudflare, always on. Open source, MIT."
        groups={[
          {
            title: 'goblin',
            links: [MEET, SIGN_IN],
          },
          {
            title: 'Follow',
            links: [
              { label: 'X, @goblin_surf', href: ELSEWHERE.x, external: true },
              { label: 'GitHub', href: ELSEWHERE.github, external: true },
            ],
          },
          {
            title: 'Policies',
            links: [
              { label: 'Terms', href: '/terms' },
              { label: 'Privacy', href: '/privacy' },
            ],
          },
        ]}
      />
    </>
  )
}

/** A screenshot of goblin, outlined so its edge holds on any surface. */
function Shot({ caption, children }: { readonly caption: string; readonly children: ReactNode }) {
  return (
    <figure className="landing-shot">
      {children}
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

function Away() {
  return (
    <Section
      id="away"
      title="It keeps working while you're away"
      visual={
        <Shot caption="Lisbon long weekend, an app goblin built and checks against trivago each morning.">
          <picture>
            <source
              media="(max-width: 40rem) and (prefers-color-scheme: dark)"
              srcSet={lisbonPhoneDark}
              width={780}
              height={1147}
            />
            <source media="(prefers-color-scheme: dark)" srcSet={lisbonDark} width={1600} height={947} />
            <img
              src={lisbonLight}
              width={1600}
              height={947}
              loading="lazy"
              decoding="async"
              alt="An app goblin built: a price target of €120 a night, a map of Alfama with three hotels pinned, and the three hotels with their prices, the cheapest under the target."
            />
          </picture>
        </Shot>
      }
    >
      <p>Ask once and goblin keeps at it, long after you close the tab.</p>
      <dl className="landing-points">
        <div>
          <dt>Routines</dt>
          <dd>It checks trivago at 07:30 every day, or wakes when a service you connected sends an event.</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>It tells you when the price drops, and your reply comes straight back to it.</dd>
        </div>
        <div>
          <dt>Apps it builds</dt>
          <dd>The hotels, the map and the plan for your weekend stay on a page of their own.</dd>
        </div>
      </dl>
    </Section>
  )
}

function Connect() {
  return (
    <Section
      id="connect"
      flip
      title="Connect anything by address"
      visual={
        <Shot caption="trivago's own view, running in the chat.">
          <img
            src={trivagoApp}
            width={1200}
            height={478}
            loading="lazy"
            decoding="async"
            alt="trivago's hotel list inside a goblin chat: Áurea Museum at 154 euros a night and My Story Hotel Figueira at 167, each with its rating and a View deal button."
          />
        </Shot>
      }
    >
      <p>
        goblin speaks MCP. Add a server by its address or take one from the shelf, allow the tools you want, and its
        apps open right in the chat.
      </p>
      <ServerList />
    </Section>
  )
}

/** Copies the command, and says so for a moment; a clipboard that refuses leaves it as it was. */
function CopyCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="landing-copy"
      onClick={() => {
        navigator.clipboard.writeText(command).then(
          () => setCopied(true),
          // expected: a refused clipboard leaves the button as it was; the command stays selectable
          () => undefined,
        )
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      <span role="status">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

function Open({ origin }: { readonly origin: string | undefined }) {
  const command = `claude mcp add --transport http goblin ${useOrigin(origin)}/mcp`
  return (
    <Section
      id="open"
      title="Yours, and open"
      visual={
        <figure className="landing-command">
          <div className="landing-command-head">
            <figcaption>Add your goblin to Claude Code</figcaption>
            <CopyCommand command={command} />
          </div>
          <pre>
            <code>{command}</code>
          </pre>
          <p>Then sign in and approve it in your browser. Any MCP client works the same way.</p>
        </figure>
      }
    >
      <p>
        Everyone gets their own agent on Cloudflare, with its own memory and its own keys to the services they connect.
        Reach yours from the web, through connected Sources, or from Claude Code and any other MCP client.
      </p>
      <p>
        Open source, MIT:{' '}
        <a className="landing-link" href={ELSEWHERE.github} rel="noopener">
          the code is on GitHub
        </a>
        .
      </p>
    </Section>
  )
}

function Close() {
  return (
    <section className="landing-close" data-tone="moss" aria-labelledby="landing-close-title">
      <div className="site-width landing-close-row">
        <h2 id="landing-close-title" className="site-heading">
          Your agent. Your apps. Your rules.
        </h2>
        <SiteButton action={MEET} />
      </div>
    </section>
  )
}
