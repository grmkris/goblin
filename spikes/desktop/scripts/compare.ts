import process from 'node:process'
const processes = ['gpui', 'tauri', 'electrobun'].map((host) =>
  Bun.spawn(['bun', 'run', 'launch', host], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  }),
)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of processes) child.kill(signal)
  })
}
const codes = await Promise.all(processes.map((child) => child.exited))
process.exitCode = codes.some((code) => code !== 0) ? 1 : 0
