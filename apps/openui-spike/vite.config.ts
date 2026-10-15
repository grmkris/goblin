import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  // OpenUI auto-loads a CDN inspector in development. This isolated playground uses
  // the production renderer in both modes, keeping every runtime asset self-hosted.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { sourcemap: false },
})
