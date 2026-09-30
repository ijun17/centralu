import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/** For the Tauri webview — the same aliases as apps/web, a different entry point. */
export default defineConfig({
  root: r('.'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@cc/protocol': r('../../packages/protocol/src/index.ts'),
      '@cc/core': r('../../packages/core/src/index.ts'),
      '@cc/platform/ports': r('../../packages/platform/src/ports/index.ts'),
      '@cc/platform/web': r('../../packages/platform/src/web/index.ts'),
      '@cc/platform/tauri': r('../../packages/platform/src/tauri/index.ts'),
      '@cc/platform/mock': r('../../packages/platform/src/mock/index.ts'),
      '@cc/ui': r('../../packages/ui/src/index.ts'),
    },
  },
  build: { target: 'safari15', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  clearScreen: false,
})
