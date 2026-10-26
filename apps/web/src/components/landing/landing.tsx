// goblin's public front door at `/` for a visitor who is signed out (a signed-in person's workspace opens instead):
// what goblin does differently, in ten seconds, that it is real (open source), and the way in, Meet your goblin. It
// reads as a storybook told over one night: the whole page is goblin's moss field, with the night drawn behind all of
// it (`World`), goblin reading on its doorstep by its lantern. The hero's panel plays a short session; each chapter
// opens with a small drawing over a heading, a little copy and one real visual; the questions follow; and as the close
// comes in, the night behind turns to dawn. The drawings are etchings the page colours (landing.css,
// scripts/landing-art.ts). Built from the shared marketing parts in @goblin/ui.
import { type CSSProperties, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { GoblinMark, MossFrame, Section, SiteBar, SiteButton, SiteFooter, type SiteLink } from '@goblin/ui'
import { HeroComposer, HeroSession, HeroStatus, useHeroSession } from './hero-session.tsx'
import { ServerList } from './server-list.tsx'
import { ToolCard } from './tool-card.tsx'
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
      <World />
      <a className="landing-skip" href="#meet">
        Skip to content
      </a>
      <SiteBar
        name="goblin"
        mark={<GoblinMark />}
        tone="moss"
        links={[
          { label: 'Questions', href: '#questions' },
          { label: 'GitHub', href: ELSEWHERE.github, external: true },
        ]}
        signIn={SIGN_IN}
        cta={MEET}
      />
      <MossFrame
        id="meet"
        title="Your own goblin, always on."
        lede="A personal agent that keeps working while you're away, uses only the tools you allow, and asks before it acts."
        actions={<SiteButton action={MEET} />}
        note="Open source. Bring your own model."
        backdrop="page"
        panelLabel="# Islands"
        panelStatus={<HeroStatus stage={session.stage} />}
        panel={<HeroSession session={session} />}
        panelFooter={<HeroComposer />}
      />
      <Away />
      <Keys />
      <Connect />
      <Open origin={origin} />
      <Questions />
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

/**
 * The night behind the whole page, decoration only: it stays put while the page moves over it, dims as the hero leaves,
 * and turns to dawn as the close comes in (landing.css follows the hero's and the close's scroll timelines).
 */
function World() {
  return (
    <div aria-hidden className="landing-world">
      <span className="landing-world-sky" />
      <div className="landing-world-night">
        <div className="landing-world-fade">
          <Scene name="night" />
        </div>
      </div>
      <div className="landing-world-dawn">
        <Scene name="dawn" />
      </div>
    </div>
  )
}

/** Where a firefly or a star sits in its drawing, in percent, how far a firefly drifts (rem) and its rhythm (s). */
interface Mote {
  readonly x: number
  readonly y: number
  readonly dx: number
  readonly dy: number
  readonly drift: number
  readonly blink: number
  readonly delay: number
}

/** Fireflies over the night's grass and hills, around goblin and its lantern. */
const FIREFLIES: readonly Mote[] = [
  { x: 35, y: 57, dx: 1.5, dy: 1, drift: 9.5, blink: 3.4, delay: -1.2 },
  { x: 45, y: 67, dx: 2, dy: 1.5, drift: 12, blink: 4.1, delay: -3.6 },
  { x: 53, y: 73, dx: -2.5, dy: 1, drift: 10.5, blink: 2.9, delay: -0.4 },
  { x: 61, y: 63, dx: 3, dy: 2, drift: 14, blink: 5.2, delay: -6.1 },
  { x: 68, y: 77, dx: -2, dy: 1.5, drift: 11, blink: 3.7, delay: -2.2 },
  { x: 76, y: 68, dx: 2.5, dy: -1, drift: 13, blink: 4.6, delay: -4.9 },
  { x: 84, y: 80, dx: -3, dy: 1, drift: 15.5, blink: 3.1, delay: -7.3 },
  { x: 91, y: 70, dx: 1.5, dy: 2, drift: 9, blink: 5.6, delay: -1.8 },
  { x: 58, y: 85, dx: 2, dy: -1.5, drift: 12.5, blink: 4.3, delay: -5.4 },
]

/** A few stars in the night's sky that twinkle, beside the ones etched in it. */
const STARS: readonly Mote[] = [
  { x: 38, y: 9, dx: 0, dy: 0, drift: 0, blink: 4.2, delay: -1 },
  { x: 47, y: 22, dx: 0, dy: 0, drift: 0, blink: 6.1, delay: -3.2 },
  { x: 56, y: 6, dx: 0, dy: 0, drift: 0, blink: 3.6, delay: -2.4 },
  { x: 64, y: 31, dx: 0, dy: 0, drift: 0, blink: 5.3, delay: -0.6 },
  { x: 72, y: 14, dx: 0, dy: 0, drift: 0, blink: 4.8, delay: -4.1 },
  { x: 81, y: 26, dx: 0, dy: 0, drift: 0, blink: 6.7, delay: -2.9 },
  { x: 88, y: 8, dx: 0, dy: 0, drift: 0, blink: 3.9, delay: -1.7 },
  { x: 95, y: 37, dx: 0, dy: 0, drift: 0, blink: 5.8, delay: -5.2 },
]

/** A firefly or a star, placed and timed by its custom properties (landing.css draws and moves it). */
function MoteDot({ mote, kind }: { readonly mote: Mote; readonly kind: 'firefly' | 'star' }) {
  const place: CSSProperties & Record<'--x' | '--y' | '--dx' | '--dy' | '--drift' | '--blink' | '--delay', string> = {
    '--x': `${String(mote.x)}%`,
    '--y': `${String(mote.y)}%`,
    '--dx': `${String(mote.dx)}rem`,
    '--dy': `${String(mote.dy)}rem`,
    '--drift': `${String(mote.drift)}s`,
    '--blink': `${String(mote.blink)}s`,
    '--delay': `${String(mote.delay)}s`,
  }
  return <span className={`landing-${kind}`} style={place} />
}

/**
 * One of the world's two drawings, covering it, with the warm light in it: at `night` goblin reads on its doorstep by
 * its lantern while the cottage across the hills sleeps, fireflies over the grass; at `dawn` it walks home as the sun
 * comes up and the cottage's windows light.
 */
function Scene({ name }: { readonly name: 'night' | 'dawn' }) {
  return (
    <span className="landing-scene" data-scene={name}>
      <span className="landing-etching" />
      {name === 'night' ? (
        <>
          {STARS.map((star) => (
            <MoteDot key={`${String(star.x)}-${String(star.y)}`} mote={star} kind="star" />
          ))}
          <span className="landing-glow" data-light="lantern" />
          {FIREFLIES.map((fly) => (
            <MoteDot key={`${String(fly.x)}-${String(fly.y)}`} mote={fly} kind="firefly" />
          ))}
        </>
      ) : (
        <span className="landing-glow" data-light="sun" />
      )}
    </span>
  )
}

/** A chapter's drawing over its heading: goblin at the work the chapter is about. */
function Chapter({ name }: { readonly name: 'away' | 'keys' | 'connect' | 'open' }) {
  return <span className="landing-etching landing-chapter" data-chapter={name} />
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
      art={<Chapter name="away" />}
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

function Keys() {
  return (
    <Section id="keys" flip art={<Chapter name="keys" />} title="Only the keys you hand it" visual={<ToolCard />}>
      <p>
        goblin calls a tool only once you allow it. Set any tool to ask you first, and goblin stops to show you the
        exact call before it runs.
      </p>
      <dl className="landing-points">
        <div>
          <dt>Asks you first</dt>
          <dd>Every call to that tool waits for your Allow, with the call in front of you.</dd>
        </div>
        <div>
          <dt>Keys for your scripts</dt>
          <dd>A key you give a script reaches only the channels and connections you chose, until it expires.</dd>
        </div>
        <div>
          <dt>A record of every turn</dt>
          <dd>Which tools ran, how long they took and what failed, kept for 30 days and never what was said.</dd>
        </div>
      </dl>
    </Section>
  )
}

function Connect() {
  return (
    <Section
      id="connect"
      art={<Chapter name="connect" />}
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
      flip
      art={<Chapter name="open" />}
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

/** What a visitor asks before signing up, answered from what goblin does today. */
const QUESTIONS: readonly { readonly question: string; readonly answer: string }[] = [
  {
    question: 'What is goblin?',
    answer:
      'A personal agent that runs in the cloud and keeps going after you close the tab. You talk to it in the browser, it works on schedules and on events from the services you connect, and it builds small apps for you.',
  },
  {
    question: 'Which model does it use?',
    answer:
      "The deployment's, or one you bring: any OpenAI-compatible endpoint and key, with your choice of its models.",
  },
  {
    question: 'What does it cost?',
    answer:
      "goblin has no plans and takes no payments. Each workspace's tokens are counted per day, and a deployment may set a daily cap.",
  },
  {
    question: 'Will it act without asking me?',
    answer: 'Only with the tools you allowed. Set a tool to ask you first, and every call to it waits for your Allow.',
  },
  {
    question: 'Where does it run?',
    answer:
      'On Cloudflare. Every workspace has its own agent, with its own memory, its own files and its own keys to the services you connect.',
  },
  {
    question: 'Can I use it from Claude Code?',
    answer:
      'Yes. goblin is an MCP server: add it with the command above, sign in, and choose what the client may do. Cursor, claude.ai and other MCP clients work the same way.',
  },
  {
    question: 'Can I run my own?',
    answer:
      'Yes. The code is on GitHub under the MIT license, and everything one deployment differs from another by is configuration: its address, mail, sign-in and model endpoint.',
  },
  {
    question: 'What does goblin record about my chats?',
    answer:
      'How each turn ran, from the tools it called and how long they took to the retries and errors, kept for 30 days. Never what was said.',
  },
]

function Questions() {
  return (
    <Section
      id="questions"
      title="Questions"
      visual={
        <div className="landing-faq">
          {QUESTIONS.map(({ question, answer }) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      }
    >
      <p>
        Anything else? Ask{' '}
        <a className="landing-link" href={ELSEWHERE.x} rel="noopener">
          @goblin_surf on X
        </a>{' '}
        or read{' '}
        <a className="landing-link" href={ELSEWHERE.github} rel="noopener">
          the code
        </a>
        .
      </p>
    </Section>
  )
}

/** The close: over the dawn the night turns into as it comes in, the night's work done, and the way in. */
function Close() {
  return (
    <section className="landing-close" data-tone="moss" aria-labelledby="landing-close-title">
      <div className="site-width landing-close-row">
        <h2 id="landing-close-title" className="site-heading">
          Leave it a job tonight.
        </h2>
        <SiteButton action={MEET} />
      </div>
    </section>
  )
}
