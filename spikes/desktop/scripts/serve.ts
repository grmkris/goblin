import { mkdir, writeFile } from 'node:fs/promises'
import { startServer } from '../service/server'
const token = crypto.randomUUID() + crypto.randomUUID()
const server = startServer({
  token,
  // oxlint-disable-next-line goblin/no-process-env -- This native desktop CLI reads launch settings, not Worker configuration.
  port: Number(process.env.GOBLIN_DESKTOP_PORT ?? 4173),
  // oxlint-disable-next-line goblin/no-process-env -- This native desktop CLI reads launch settings, not Worker configuration.
  liveOrigin: process.env.GOBLIN_DESKTOP_ORIGIN,
})
await mkdir('artifacts', { recursive: true, mode: 0o700 })
await writeFile(
  'artifacts/connection.local.json',
  JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, token }),
  { mode: 0o600 },
)
process.stdout.write(
  `Desktop companion ready on 127.0.0.1:${server.port}. Start a shell with bun run launch <browser|tauri|electrobun|gpui>.\n`,
)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server
      .stop()
      .then(() => process.exit(0))
      .catch(() => {
        // expected: shutdown has no recovery path; report a fixed summary and a nonzero process status.
        process.stderr.write('Desktop companion failed to shut down cleanly.\n')
        process.exit(1)
      })
  })
