import { defineConfig } from 'vite'

export default defineConfig({
  root: 'shared',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
})
