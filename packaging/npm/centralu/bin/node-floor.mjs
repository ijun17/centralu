/**
 * The oldest Node the bundled host runs on, and what the launcher says when it is run on an older one.
 *
 * **The floor is `engines.node` of this package, read here and nowhere restated.** The host's native
 * database module (better-sqlite3 13) declares Node-API 10, which Node has from 22.14.0. Under an
 * older 22.x (and under 20) it loads, then crashes on its first use with an access violation
 * (`0xC0000005`, exit 3221225477, on Windows) or SIGSEGV (measured on 22.12.0, Windows and macOS,
 * issue #699), before the host logs a line. The hub reads the same value from its copy of this
 * package's `package.json` (`packages/agent-host/src/links/node-floor.ts`), and
 * `tooling/engines.test.ts` keeps the other declarations equal to it.
 *
 * Lives in its own file so it can be tested (tooling/launcher-node-floor.test.ts): the launcher
 * itself runs commands at import time. Plain JavaScript on Node's own modules and `semver.mjs`.
 */
import { isNewer } from './semver.mjs'

/** `>=22.14.0` or `>=22.14` → `22.14.0`; throws on any other shape, which `engines` must not take */
export function floorOf(range) {
  const m = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(range).trim())
  if (!m) throw new Error(`engines.node must be a plain floor like ">=22.14.0", not ${JSON.stringify(range)}`)
  return `${m[1]}.${m[2]}.${m[3] ?? '0'}`
}

/** Whether `found` (`22.12.0` or `v22.12.0`) is older than `floor`; a version that does not parse is let through */
export function belowFloor(found, floor) {
  const v = String(found).trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+/.test(v)) return false
  return isNewer(floor, v)
}

/**
 * The one sentence for a launcher that will not start the host on this Node: the Node it found, the
 * floor, and the two ways out. It names no command, since it is also what the hub reads out of the
 * `--detach` answer.
 */
export function oldNodeSentence(found, floor) {
  const v = String(found).replace(/^v/i, '')
  return (
    `centralu serve needs Node ${floor} or newer and this is Node ${v}: update Node on this machine, ` +
    'or link this machine from a Centralu window on another computer, which installs a Node of its own there.'
  )
}
