import { readFile } from 'node:fs/promises'
import { hostName } from '../shared/src/types'
const host = hostName(process.argv[2] ?? null)
const raw: unknown = JSON.parse(await readFile('artifacts/connection.local.json', 'utf8'))
if (
  typeof raw !== 'object' ||
  raw === null ||
  !('origin' in raw) ||
  typeof raw.origin !== 'string' ||
  !('token' in raw) ||
  typeof raw.token !== 'string'
)
  throw new Error('Start bun run serve first')
const url = new URL(raw.origin)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid companion origin')
url.searchParams.set('host', host)
url.hash = new URLSearchParams({ token: raw.token }).toString()
if (host === 'browser') {
  // The local capability is displayed only to the person opening this fixture. Never commit or share this URL.
  process.stdout.write(`${url.toString()}\n`)
} else {
  const commands = {
    tauri: ['../node_modules/.bin/tauri', 'dev'],
    electrobun: ['../node_modules/.bin/electrobun', 'dev'],
    gpui: ['cargo', 'run', '--locked', '-p', 'goblin-gpui-spike'],
  }
  const processHandle = Bun.spawn(commands[host], {
    cwd: host === 'gpui' ? process.cwd() : `${process.cwd()}/${host}`,
    env: {
      // oxlint-disable-next-line goblin/no-process-env -- This native desktop CLI reads launch settings, not Worker configuration.
      ...process.env,
      GOBLIN_DESKTOP_URL: url.toString(),
      GOBLIN_DESKTOP_CONNECTION: `${process.cwd()}/artifacts/connection.local.json`,
    },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => processHandle.kill(signal))
  process.exitCode = await processHandle.exited
}
