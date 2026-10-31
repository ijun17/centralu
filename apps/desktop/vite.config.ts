import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { aliases } from '../../tooling/aliases.js'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/** For the Tauri webview — the same aliases as apps/web, a different entry point. */
export default defineConfig({
  root: r('.'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: aliases({ '@cc/platform/tauri': 'packages/platform/src/tauri/index.ts' }),
  },
  build: { target: 'safari15', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  clearScreen: false,
})
