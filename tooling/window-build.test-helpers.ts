import { fileURLToPath } from 'node:url'
import { build, type Rollup } from 'vite'

/** The window's Vite builds: what ships (`desktop`, the Tauri webview) and what e2e and perf build (`web`) */
export const WINDOW_BUILDS = {
  desktop: 'apps/desktop/vite.config.ts',
  web: 'apps/web/vite.config.ts',
}

/** The chunks one of them builds, in memory. `minify: false` is faster; minified is what ships. */
export async function windowChunks(config: string, { minify }: { minify: boolean }): Promise<Rollup.OutputChunk[]> {
  const out = (await build({
    configFile: fileURLToPath(new URL(`../${config}`, import.meta.url)),
    logLevel: 'silent',
    build: { write: false, sourcemap: false, minify, reportCompressedSize: false },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  return (Array.isArray(out) ? out : [out]).flatMap((o) => o.output.filter((c): c is Rollup.OutputChunk => c.type === 'chunk'))
}
