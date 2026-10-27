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
    new URL('./codex/orchestrator-bridge.mjs', import.meta.url), // the source tree
    new URL('./codex-orchestrator-bridge.mjs', import.meta.url), // the bundled build-output layout
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`orchestrator bridge not found: ${candidates.join(', ')}`)
  return found
}

/**
 * The `agy` gate hook's two files (`agy-gate.mjs` and the `gate-answer.mjs` it imports), which `agy` runs with `node`
 * from a session's plugin root (`agy/plugin-root.ts` copies both there). `./agy/` is the same place in both layouts:
 * beside this module in the source tree, and beside the bundled host, where the bundle step is to put the two files.
 */
export function agyGatePaths(): { entry: string; answer: string } {
  const entry = fileURLToPath(new URL('./agy/agy-gate.mjs', import.meta.url))
  const answer = fileURLToPath(new URL('./agy/gate-answer.mjs', import.meta.url))
  if (!existsSync(entry) || !existsSync(answer)) throw new Error(`agy gate hook not found: ${entry}, ${answer}`)
  return { entry, answer }
}
