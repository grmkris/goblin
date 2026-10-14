// A private, fresh fixture companion for one benchmark trial; it never uses the live dev origin.
import { writeFile } from 'node:fs/promises'
import { startServer } from '../service/server'
const path = process.argv[2]
if (!path) throw new Error('Pass a private connection-file path')
const token = crypto.randomUUID() + crypto.randomUUID()
const server = startServer({ token, liveOrigin: 'http://127.0.0.1:1' })
await writeFile(path, JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, token }), { mode: 0o600 })
process.stdout.write(`COMPANION_READY ${JSON.stringify({ pid: process.pid })}\n`)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
