import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  // VITE_BASE is set by CI to /<repo-name>/ for GitHub Pages project sites.
  // For a custom domain or user/org site set it to '/'.
  base: process.env.VITE_BASE ?? '/',
})
