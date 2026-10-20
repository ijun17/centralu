import { isObj } from '../json-value.js'

/** What a failed child process (execFile, `runGit`, a spawn) or a system call carries besides its message */
export type ExecFailure = {
  code?: unknown
  stdout?: string
  stderr?: string
  message?: string
  /** `runGit` and `execFile` say the call ran past its time */
  timedOut?: boolean
  /** `gitCancelled`: the call's signal fired */
  aborted?: unknown
}

/**
 * The parts of a failure that the callers read, each only when it is of the kind they expect: a `catch` gets
 * `unknown`, and a rejection need not be an Error (nor its `stderr` text: a call with `encoding: 'buffer'` has bytes).
 */
export function execFailure(e: unknown): ExecFailure {
  if (!isObj(e)) return {}
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return { code: e.code, stdout: text(e.stdout), stderr: text(e.stderr), message: text(e.message), timedOut: e.timedOut === true ? true : undefined, aborted: e.aborted }
}
