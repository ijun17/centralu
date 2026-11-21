import { readFile, readdir } from 'node:fs/promises'
import { HOST_PLATFORM, type Platform } from '../os.js'
import { errorMessage } from '@cc/protocol'
import { execText, isExecFailure } from './exec.js'

/**
 * One variable of other processes' environments (#1898), for the leftover finder's owner mark (`dev-services/strays.ts`) and
 * the e2e host mark. An environment holds secrets every process of the user can read, so only the asked variable's value leaves
 * this module: the rest is never returned, kept, logged or put in an error. Linux and WSL: `/proc/<pid>/environ` (a process
 * that ended or is another user's is left out). macOS: `ps -E -ww` prints the environment after the arguments (measured on
 * macOS 27.2, 2026-11-12: shown in full for an ad hoc signed node and for `claude` under the hardened runtime, not at all for a
 * platform binary of the system volume such as `/bin/sleep`, its own user's child included; `-ww` lifts the width limit, and
 * the system's argument size limit bounds it). Windows: nothing reads another process's environment and nothing needs to, as
 * there is no leftover finder (`hasPs`) and a stop sweeps by parent and creation time (`kill-tree.ts`). A process missing from
 * the answer could not be read or lacks the variable, one answer on purpose, as neither says it is ours; a failed listing
 * rejects with why and nothing it read
 */
export async function environmentValues(
  name: string,
  pids: readonly number[] | 'all',
  platform: Platform = HOST_PLATFORM,
  run: typeof execText = execText,
): Promise<Map<number, string>> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not a variable name: ${name}`)
  if (platform === 'linux') return procValues(name, pids)
  if (platform !== 'darwin') return new Map()
  if (pids !== 'all' && pids.length === 0) return new Map()
  const which = pids === 'all' ? ['-A'] : ['-p', pids.join(',')]
  try {
    const { stdout } = await run('ps', ['-E', '-ww', '-o', 'pid=,command=', ...which], { timeoutMs: PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
    return psEnvironmentValues(stdout, name)
  } catch (e) {
    // `ps -p` exits 1 when a listed pid has ended since it was listed, and still prints the others: that is an answer
    if (isExecFailure(e) && typeof e.code === 'number' && !e.ended) return psEnvironmentValues(e.stdout, name)
    // A failure carries what `ps` printed, every environment it read: only why it failed goes on
    throw new Error(`ps could not list environments: ${isExecFailure(e) ? (e.ended ?? `exit ${String(e.code)}`) : errorMessage(e)}`)
  }
}

/**
 * How long the macOS listing may take: 30 ms for all 868 processes of a Mac (2026-11-12), while the leftover finder's other two
 * listings take 12 s each of the 30 s the screen gives its call
 */
const PS_TIMEOUT_MS = 5_000

async function procValues(name: string, pids: readonly number[] | 'all'): Promise<Map<number, string>> {
  const all = pids === 'all' ? (await readdir('/proc')).filter((d) => /^\d+$/.test(d)).map(Number) : pids
  const out = new Map<number, string>()
  await Promise.all(
    all.map(async (pid) => {
      try {
        const value = environValue(await readFile(`/proc/${pid}/environ`, 'utf8'), name)
        if (value !== undefined) out.set(pid, value)
      } catch {
        // Ended meanwhile, or another user's: not readable, so not known to carry it
      }
    }),
  )
  return out
}

/** `name`'s value in a `/proc/<pid>/environ` text (`NAME=value` entries, each ended by NUL) */
export function environValue(environ: string, name: string): string | undefined {
  const prefix = `${name}=`
  for (const entry of environ.split('\0')) if (entry.startsWith(prefix)) return entry.slice(prefix.length)
  return undefined
}

/**
 * `name`'s value per pid in `ps -E -ww -o pid=,command=` output: arguments and environment are joined by spaces, so the entry
 * is the last whole word on the line; a value with a space is read up to the space
 */
export function psEnvironmentValues(out: string, name: string): Map<number, string> {
  const values = new Map<number, string>()
  const entry = new RegExp(`(?:^|\\s)${name}=(\\S*)`, 'g')
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line)
    if (!m) continue
    const found = [...(m[2] ?? '').matchAll(entry)].pop()
    if (found) values.set(Number(m[1]), found[1] ?? '')
  }
  return values
}
