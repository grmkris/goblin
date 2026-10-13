import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'vitest',
        replacement: fileURLToPath(new URL('../../apps/runtime/node_modules/vitest/dist/index.js', import.meta.url)),
      },
      {
        find: /^effect\/(.+)$/u,
        replacement: fileURLToPath(new URL('../../node_modules/effect/dist', import.meta.url)) + '/$1.js',
      },
      {
        find: 'effect',
        replacement: fileURLToPath(new URL('../../node_modules/effect/dist/index.js', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['spikes/mobile/test/owner.local.ts'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    env: {
      CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000000',
      CLOUDFLARE_API_TOKEN: 'local-placeholder-token',
      ALCHEMY_PLAIN: '1',
      GOBLIN_HARNESS_PORT: '19021',
    },
  },
})
