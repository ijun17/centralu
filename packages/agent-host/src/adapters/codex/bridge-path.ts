import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The location of the bridge script.
 *
 * The same problem as schema.sql: dev (tsx) reads from the source tree, while the bundled,
 * packaged app reads next to the build output. Since codex starts it directly with `node <path>`,
 * **a plain .mjs file has to exist at that spot** — the bundle script copies it alongside.
 */
export function bridgePath(): string {
  const candidates = [
    new URL('./orchestrator-bridge.mjs', import.meta.url), // the source tree
    new URL('./codex-orchestrator-bridge.mjs', import.meta.url), // the bundled build-output layout
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`orchestrator bridge not found: ${candidates.join(', ')}`)
  return found
}
