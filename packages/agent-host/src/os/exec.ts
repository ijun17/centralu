import type { Env, Os } from './port.js'
import { realOs } from './real.js'
import { errnoCode } from './errors.js'

/** What a probe that failed carries, as `execFile`'s rejection did: callers read the output of a CLI that exited with 1 */
export type ExecFailure = Error & { stdout: string; stderr: string; code: number | null; ended?: 'timeout' | 'overflow' | 'aborted' | 'stopped' }

/** Whether a rejection of `execText` is a program that ran and failed (it carries its output), not one that could not start */
export const isExecFailure = (e: unknown): e is ExecFailure => e instanceof Error && 'stdout' in e && 'stderr' in e

export type ProbeOptions = {
  timeoutMs: number; env?: Env; cwd?: string; maxBuffer?: number; input?: string
  /** What a failure calls the program, also one that could not be started: a tool by its name, not the Node its shim runs or the path it was looked for at (`execTool`) */
  name?: string
}

/**
 * A program asked one short question (`--version`, `auth status`), as text. The same as `util.promisify(execFile)` with a
 * `timeout`, except for what a timeout ends: `execFile` signals the pid, and a `.cmd` shim's `cmd.exe` died while the Node
 * process under it kept running, where `OsProcesses.run` ends the whole tree (parents first on Windows, #2141).
 *
 * Resolves with the output of a run that exited 0; rejects with an `ExecFailure` for any other end, a timeout included
 * (`ended: 'timeout'`), and with the start's own error when the program could not be started (ENOENT). It stays in the
 * host's group (`StartOptions.contained`): a probe is ended by whatever ends the host's group.
 */
export async function execText(command: string, args: readonly string[], options: ProbeOptions, os: Pick<Os, 'processes'> = realOs()): Promise<{ stdout: string; stderr: string }> {
  const { name, ...run } = options
  let r: Awaited<ReturnType<typeof os.processes.run>>
  try {
    r = await os.processes.run(command, args, { ...run, contained: false })
  } catch (e) {
    if (name === undefined) throw e
    const code = errnoCode(e)
    throw Object.assign(new Error(`${name} could not be started${code ? ` (${code})` : ''}`, { cause: e }), code ? { code } : {})
  }
  return textOf(name ?? command, { ...r, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') })
}

/**
 * `execText` for a caller that cannot wait: `runSync` blocks the host, and a limit ends that one process only, so it is for
 * a program that starts nothing (the list `guard/timed-start` holds). Anything that may start children is run with
 * `execText`, which ends a tree. The same answer and the same failure; a program that could not be started or ran past its
 * limit throws the error `spawnSync` gave.
 */
export function execTextSync(command: string, args: readonly string[], options: Omit<ProbeOptions, 'name'>, os: Pick<Os, 'processes'> = realOs()): { stdout: string; stderr: string } {
  const r = os.processes.runSync(command, args, options)
  if (r.error) throw r.error
  return textOf(command, r)
}

/** The one mapping of a finished run to the answer or the failure of `execText` */
function textOf(command: string, r: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ended?: ExecFailure['ended'] }): { stdout: string; stderr: string } {
  const { stdout, stderr } = r
  if (r.code === 0 && !r.ended) return { stdout, stderr }
  const why = r.ended ? `ended by its ${r.ended}` : r.signal ? `killed by ${r.signal}` : `exited ${String(r.code)}`
  const failure: ExecFailure = Object.assign(new Error(`${command} ${why}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`), { stdout, stderr, code: r.code, ...(r.ended ? { ended: r.ended } : {}) })
  throw failure
}
