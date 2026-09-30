/**
 * Sets the execute permission on node-pty's spawn-helper.
 *
 * This file is an executable, but the package manager sometimes drops the +x bit when it
 * extracts the package (we actually hit this with pnpm's prebuild extraction). When that happens
 * the shell does not start, only `posix_spawnp failed` is left behind, and the terminal is
 * entirely broken with no visible cause.
 *
 * Runs automatically after install (postinstall).
 */
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

try {
  const root = dirname(require.resolve('node-pty/package.json'))
  const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  if (existsSync(helper)) {
    chmodSync(helper, 0o755)
    console.log(`[node-pty] spawn-helper 실행 권한 확인: ${helper}`)
  }
} catch {
  // Silently skip in environments without node-pty (a web-only CI, for example)
}
