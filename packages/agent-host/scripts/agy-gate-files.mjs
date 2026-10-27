import { cpSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The two files of Antigravity's `PreToolUse` hook (docs/plans/antigravity-adapter.md §5): `agy-gate.mjs` is the command
 * `agy` runs and imports `./gate-answer.mjs`, so the packaged host folder carries both, side by side, as plain files (the
 * hook runs with `node <path>`, no bundler in between). `gatePath()` looks for the command there.
 */
export const AGY_GATE_FILES = ['agy-gate.mjs', 'gate-answer.mjs']

export function copyAgyGate(root, out) {
  for (const f of AGY_GATE_FILES) cpSync(join(root, 'packages/agent-host/src/adapters/agy', f), join(out, f))
}
