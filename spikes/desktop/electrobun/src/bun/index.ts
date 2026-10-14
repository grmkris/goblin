import { BrowserWindow } from 'electrobun/main'
// oxlint-disable-next-line goblin/no-process-env -- This native desktop CLI reads launch settings, not Worker configuration.
const value = process.env.GOBLIN_DESKTOP_URL
if (!value) throw new Error('Start the companion, then use bun run launch electrobun')
const url = new URL(value)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
  throw new Error('Only the local desktop companion may be opened')
export const mainWindow = new BrowserWindow({
  title: 'Goblin · Electrobun spike',
  url: url.toString(),
  sandbox: true,
  renderer: 'native',
  frame: { width: 1180, height: 820, x: 100, y: 80 },
})
// oxlint-disable-next-line goblin/no-process-env -- Opt-in local benchmark signalling, never enabled in the renderer.
if (process.env.GOBLIN_DESKTOP_BENCH === '1')
  process.stdout.write(
    `DESKTOP_READY ${JSON.stringify({ version: 1, shell: 'electrobun', stage: 'window_created', pid: process.pid })}\n`,
  )
