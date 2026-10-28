import * as Alchemy from 'alchemy'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Effect from 'effect/Effect'

export default Alchemy.Stack(
  'goblin-openui-spike',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    const site = yield* Cloudflare.Website.Vite('Playground', {
      // oxlint-disable-next-line goblin/resource-name-via-stage -- This independent stack uses Alchemy.Stage directly; Goblin's resolver names its dev/prod app.
      name: `goblin-openui-spike-${stage}`,
      rootDir: import.meta.dirname,
      workersDev: true,
      compatibility: { date: '2026-10-15' },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } },
      memo: {
        include: [
          'src/**',
          'public/**',
          'index.html',
          'vite.config.ts',
          'package.json',
          '../web/src/**',
          '../web/package.json',
          '../../patches/openui/**',
          '../../packages/ui/src/**',
          '../../packages/kit/src/**',
        ],
        lockfile: true,
      },
    })
    return { url: site.url }
  }),
)
