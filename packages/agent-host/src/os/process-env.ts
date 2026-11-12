import { readFile, readdir } from 'node:fs/promises'
import { HOST_PLATFORM, type Platform } from '../os.js'
import { execText } from './exec.js'

/**
 * One variable of other processes' environments (#1898): the one reader of it, for the leftover finder's owner mark
 * (`dev-services/strays.ts`) and the e2e host mark (`e2e/fixtures/real-host.ts`).
 *
 * An environment holds secrets (a session's `CC_HOST_CREDENTIAL`, tokens of the person's own tools), and every process of
 * the same user can read it. So only the asked variable's value leaves this module: the rest is never returned, kept,
 * logged or put in an error.
 *
 * - Linux and WSL: `/proc/<pid>/environ`, the environment the process was started with. A process that ended, or is
 *   another user's, cannot be read and is left out.
 * - macOS: `ps -E -ww`, which prints a process's environment after its arguments. Measured on macOS 27.2 (2026-11-12):
 *   shown in full for an ad hoc signed node and for the `claude` binary under the hardened runtime; not shown at all for
 *   a platform binary of the system volume (`/bin/sleep`), its own user's child included. `-ww` lifts the width limit;
 *   what `ps` reads is bounded by the system's argument size limit, which the environment had to fit in to start (not
 *   measured: an environment near that limit).
 * - Windows: nothing reads another process's environment (it takes reading that process's memory), and nothing needs
 *   to: there is no leftover finder there (`hasPs`), and a stop sweeps by parent and creation time (`kill-tree.ts`).
 *
 * A process missing from the answer could not be read or does not have the variable; the two are one answer on purpose,
 * since neither says the process is ours. A listing that failed as a whole (macOS `ps`) rejects.
 */
export async function environmentValues(name: string, pids: readonly number[] | 'all', platform: Platform = HOST_PLATFORM): Promise<Map<number, string>> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not a variable name: ${name}`)
  if (platform === 'linux') return procValues(name, pids)
  if (platform !== 'darwin') return new Map()
  if (pids !== 'all' && pids.length === 0) return new Map()
  const which = pids === 'all' ? ['-A'] : ['-p', pids.join(',')]
  const { stdout } = await execText('ps', ['-E', '-ww', '-o', 'pid=,command=', ...which], { timeoutMs: 12_000, maxBuffer: 64 * 1024 * 1024 })
  return psEnvironmentValues(stdout, name)
}

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
 * `name`'s value per pid in `ps -E -ww -o pid=,command=` output. Arguments and environment are joined by spaces, so the
 * entry is taken as a whole word, the last one on the line (the environment comes after the arguments); a value with a
 * space in it is read up to the space.
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
