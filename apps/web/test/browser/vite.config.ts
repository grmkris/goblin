import path from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: import.meta.dirname,
  // The app's own static files (the shelf's icons, the favicon), as the deployed site serves them.
  publicDir: path.join(import.meta.dirname, '../../public'),
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), react()],
  server: { host: '127.0.0.1', port: 0 },
})
