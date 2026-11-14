import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { aliases } from '../../tooling/aliases.js'
import { PURE_CALLS } from '../../tooling/pure-calls.js'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('.'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: aliases({ '@cc/platform/mock/demo': 'packages/platform/src/mock/demo.ts' }),
  },
  build: { rolldownOptions: { treeshake: { manualPureFunctions: PURE_CALLS } } },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
})
