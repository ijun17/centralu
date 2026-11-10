import type { Env, Os } from './port.js'
import { realOs } from './real.js'

/** What a probe that failed carries, as `execFile`'s rejection did: callers read the output of a CLI that exited with 1 */
export type ExecFailure = Error & { stdout: string; stderr: string; code: number | null; ended?: 'timeout' | 'overflow' | 'aborted' | 'stopped' }

/**
 * A program asked one short question (`--version`, `auth status`), as text. The same as `util.promisify(execFile)` with a
 * `timeout`, except for what a timeout ends: `execFile` signals the pid, and a `.cmd` shim's `cmd.exe` died while the Node
 * process under it kept running, where `OsProcesses.run` ends the whole tree (parents first on Windows, #2141).
 *
 * Resolves with the output of a run that exited 0; rejects with an `ExecFailure` for any other end, a timeout included
 * (`ended: 'timeout'`), and with the start's own error when the program could not be started (ENOENT).
 */
export async function execText(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: Env; cwd?: string; maxBuffer?: number },
  os: Pick<Os, 'processes'> = realOs(),
): Promise<{ stdout: string; stderr: string }> {
  // In the host's group: a probe is ended by whatever ends the host's group (`StartOptions.contained`)
  const r = await os.processes.run(command, args, { ...options, contained: false })
  const stdout = r.stdout.toString('utf8')
  const stderr = r.stderr.toString('utf8')
  if (r.code === 0 && !r.ended) return { stdout, stderr }
  const why = r.ended ? `ended by its ${r.ended}` : r.signal ? `killed by ${r.signal}` : `exited ${String(r.code)}`
  const failure: ExecFailure = Object.assign(new Error(`${command} ${why}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`), { stdout, stderr, code: r.code, ...(r.ended ? { ended: r.ended } : {}) })
  throw failure
}
