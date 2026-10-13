import { Head } from 'one'

/** The web preview needs an explicit mobile viewport and a bounded root for the native flex layout. */
export function Document() {
  return (
    <Head>
      <title>goblin mobile spike</title>
      <meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content" />
      <meta name="theme-color" content="#314d3c" />
      <style href="goblin-mobile-shell" precedence="default">{`
        html, body { margin: 0; height: 100%; background: #f6f7f4; overscroll-behavior: none; }
        html { -webkit-text-size-adjust: 100%; }
        body { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
        body > div { min-height: 0; flex: 1; display: flex; flex-direction: column; }
      `}</style>
    </Head>
  )
}
