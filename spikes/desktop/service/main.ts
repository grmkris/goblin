import { mkdir, writeFile } from 'node:fs/promises'
import { startServer } from './server'
const token = crypto.randomUUID() + crypto.randomUUID()
const server = startServer({
  token,
  port: Number(process.env.GOBLIN_DESKTOP_PORT ?? 4173),
  liveOrigin: process.env.GOBLIN_DESKTOP_ORIGIN,
})
await mkdir('artifacts', { recursive: true, mode: 0o700 })
await writeFile(
  'artifacts/connection.local.json',
  JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, token }),
  { mode: 0o600 },
)
console.log(
  `Desktop companion ready on 127.0.0.1:${server.port}. Start a shell with bun run launch <browser|tauri|electrobun|gpui>.`,
)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.stop()
    process.exit(0)
  })
