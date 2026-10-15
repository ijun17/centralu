import { isNewerVersion } from '@cc/protocol'

/**
 * The oldest Node the host runs on, and what the hub does about a machine whose Node is older
 * (issue #699). The bundled database module declares Node-API 10, which Node has from 22.14.0; under an
 * older one the host crashes on its first database call (exit 3221225477 on Windows, SIGSEGV elsewhere)
 * before it logs anything, which used to reach the person as the raw end of `serve.log`.
 *
 * **The floor is `engines.node` of the npm package, read from the copy the bundle carries**
 * (`nodeFloor()` in install.ts), the same value the launcher checks
 * (`packaging/npm/centralu/bin/node-floor.mjs`).
 */

/** `>=22.14.0` or `>=22.14` → `22.14.0`; throws on any other shape */
export function floorOf(range: string): string {
  const m = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range.trim())
  if (!m) throw new Error(`engines.node must be a plain floor like ">=22.14.0", not ${JSON.stringify(range)}`)
  return `${m[1]}.${m[2]}.${m[3] ?? '0'}`
}

/** Whether `found` (`22.12.0` or `v22.12.0`) is older than `floor`; a version that does not parse is let through */
export function belowFloor(found: string | null | undefined, floor: string): boolean {
  const v = (found ?? '').trim().replace(/^v/, '')
  return /^\d+\.\d+\.\d+/.test(v) && isNewerVersion(floor, v)
}

/**
 * The ways a host dies on a Node below the floor: an access violation, as a Windows exit code
 * (unsigned, as PowerShell and `serve` report it, or signed as some tools do) or SIGSEGV
 */
const CRASH = /(?<!\w)(3221225477|-1073741819|0xC0000005|SIGSEGV)(?!\w)/i

/** Whether a start failure's text says the host crashed the way an unsupported Node makes it crash */
export function isHostCrash(message: string): boolean {
  return CRASH.test(message)
}

/**
 * A start that cannot work on the Node there, from the launcher's own refusal (`reason: node_too_old`)
 * or from the host's crash at startup. `found` is the Node the launcher named, when it did
 */
export class NodeTooOld extends Error {
  constructor(
    message: string,
    readonly kind: 'refused' | 'crashed',
    readonly found: string | null,
  ) {
    super(message)
    this.name = 'NodeTooOld'
  }
}

type Why = { name: string; found: string | null; floor: string; kind: 'refused' | 'crashed' }

/** What is wrong with the Node on the machine, as a clause */
function problem({ name, found, floor, kind }: Why): string {
  if (kind === 'refused' || belowFloor(found, floor)) return `the Node on ${name}${found ? ` (${found})` : ''} is older than ${floor}, the oldest Centralu runs on`
  return `Centralu crashed on start under the Node on ${name}${found ? ` (${found})` : ''}, and ${floor} is the oldest Centralu runs on`
}

/** The one sentence after the hub installed its own Node on a machine whose Node was too old */
export function switchedSentence(o: Why & { node: string }): string {
  return `Centralu installed its own Node ${o.node} on ${o.name}, because ${problem(o)}.`
}

/**
 * The one sentence when the hub did not switch the machine to its own Node (`reason`: why not), so
 * the person updates Node there
 */
export function updateNodeSentence(o: Why & { reason: string }): string {
  const p = problem(o)
  return `${p[0]!.toUpperCase()}${p.slice(1)}, and this computer did not install its own Node there (${o.reason}): update Node there, and Centralu starts again.`
}
