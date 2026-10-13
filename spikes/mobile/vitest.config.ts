import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Shared schemas and the browser projection must execute against the same Effect instance as the client.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^effect\/(.+)$/u,
        replacement: fileURLToPath(new URL('./node_modules/effect/dist', import.meta.url)) + '/$1.js',
      },
      { find: 'effect', replacement: fileURLToPath(new URL('./node_modules/effect/dist/index.js', import.meta.url)) },
    ],
    dedupe: ['effect'],
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 10_000 },
})
