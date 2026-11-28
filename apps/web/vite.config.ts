import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { aliases } from '../../tooling/aliases.js'
import { PURE_CALLS } from '../../tooling/pure-calls.mjs'
import { MAIN_URL, checkoutMarker } from '../../tooling/dev-server-checkout.js'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('.'),
  plugins: [react(), tailwind(), checkoutMarker()],
  resolve: {
    alias: aliases({ '@cc/platform/mock/demo': 'packages/platform/src/mock/demo.ts' }),
  },
  build: { rolldownOptions: { treeshake: { manualPureFunctions: PURE_CALLS } } },
  // The e2e suite's main port: its run reuses this server when it serves the same checkout
  server: { host: '127.0.0.1', port: Number(new URL(MAIN_URL).port), strictPort: true },
})
