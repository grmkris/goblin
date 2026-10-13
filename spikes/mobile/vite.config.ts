import { one } from 'one/vite'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // Native runners read this port; keep it aligned with the dev script's explicit port.
  server: { host: '127.0.0.1', port: 18980, strictPort: true },
  resolve: {
    alias: [
      {
        find: /^effect\/(.+)$/u,
        replacement: fileURLToPath(new URL('./node_modules/effect/dist', import.meta.url)) + '/$1.js',
      },
      { find: 'effect', replacement: fileURLToPath(new URL('./node_modules/effect/dist/index.js', import.meta.url)) },
    ],
    dedupe: ['effect', 'react', 'react-dom'],
  },
  plugins: [
    one({
      web: { defaultRenderMode: 'spa' },
      native: {
        app: {
          name: 'GoblinSpike',
          scheme: 'goblin-spike',
          ios: { bundleId: 'surf.goblin.spike', deploymentTarget: '17.0' },
          android: { applicationId: 'surf.goblin.spike' },
        },
      },
      router: { linking: { scheme: 'goblin-spike' } },
    }),
  ],
})
