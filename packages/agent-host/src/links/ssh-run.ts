import { spawn, type ChildProcess } from 'node:child_process'
import { Tail } from '../stream-text.js'

/**
 * Running the person's own `ssh` to the end, within bounds: the one runner behind the tunnel's
 * asking ssh (`SshTunnel.run`), the machine probe (`probe.ts`) and `ssh -G` (`ssh-config.ts`) (#428).
 *
 * `ConnectTimeout` only bounds the connection, so each run also has a deadline and a bound on its
 * output: a remote command that never ends, or never stops printing, would otherwise hold the call
 * and its memory for good. Past either, the ssh is ended (`endChild`) and the run rejects. Only the
 * end of stderr is kept: what it is read for is the last line (`lastLine`). Both streams are decoded
 * as streams, so a character that arrives in two chunks is one character.
 */

export type SshRunResult = { code: number | null; stdout: string; stderr: string }

/** Why a run did not get to its end: its deadline, too much output, or an ssh that could not start (ENOENT) */
export type SshRunFailureKind = 'timeout' | 'output' | 'spawn' | 'ack'

export class SshRunFailure extends Error {
  constructor(
    readonly kind: SshRunFailureKind,
    message: string,
  ) {
    super(message)
  }
}

export type SshRunOptions = {
  /** The ssh program; default `ssh` on PATH */
  ssh?: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  /** Written to ssh's stdin, then closed. Absent: stdin is not a pipe at all */
  stdin?: string
  /**
   * A line the remote prints once it has read the stdin (#1360): when none has come within `withinMs` of the spawn the
   * run rejects with `message` (kind `ack`) and the ssh is ended, instead of waiting for `timeoutMs`. The marker stays in the
   * output the run answers; the caller takes it out
   */
  ack?: { marker: string; withinMs: number; message: string }
  timeoutMs: number
  /** The most characters stdout may hold before the ssh is stopped; default `SSH_STDOUT_LIMIT` */
  stdoutLimit?: number
  /** How much of the end of stderr is kept; default `SSH_STDERR_KEEP` */
  stderrKeep?: number
  /** Who the messages name: `ssh to <label>` */
  label: string
  /** Handed the child once it is spawned, so an owner can end it on close */
  onChild?: (child: ChildProcess) => void
}

/** The most characters an asking ssh may print on stdout before it is stopped: the answers read from it are a line or a log tail */
export const SSH_STDOUT_LIMIT = 1024 * 1024
/** How much of the end of an asking ssh's stderr is kept */
export const SSH_STDERR_KEEP = 64 * 1024
/** How long an ssh asked to stop with TERM has before it is KILLed */
export const SSH_KILL_GRACE_MS = 2000

/**
 * Asks a child to stop with SIGTERM, and KILLs it if it has not exited after `graceMs`. Resolves once
 * it has exited or the grace is over, whichever is first; a child that has already exited resolves at
 * once. ssh ends what it started itself (a `ProxyCommand`, `ProxyJump`'s second ssh) on SIGTERM.
 */
export function endChild(child: ChildProcess, graceMs = SSH_KILL_GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, graceMs)
    t.unref()
    child.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`
}

/** Runs ssh to the end and answers what it printed, within bounds (see the file header). Rejects with `SshRunFailure` */
export function runSsh(opts: SshRunOptions): Promise<SshRunResult> {
  const stdoutLimit = opts.stdoutLimit ?? SSH_STDOUT_LIMIT
  return new Promise((resolve, reject) => {
    const child = spawn(opts.ssh ?? 'ssh', [...opts.args], {
      env: opts.env ?? process.env,
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (opts.stdin !== undefined) {
      // A remote that exits before reading it all closes the pipe: that is its answer, not ours to throw
      child.stdin!.on('error', () => {})
      child.stdin!.end(opts.stdin)
    }
    opts.onChild?.(child)
    let stdout = ''
    const stderr = new Tail(opts.stderrKeep ?? SSH_STDERR_KEEP)
    let settled = false
    const fail = (kind: SshRunFailureKind, message: string) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(ackDeadline)
      if (kind !== 'spawn') void endChild(child)
      reject(new SshRunFailure(kind, message))
    }
    const deadline = setTimeout(() => fail('timeout', `ssh to ${opts.label} did not finish within ${seconds(opts.timeoutMs)}`), opts.timeoutMs)
    const ack = opts.ack
    const ackDeadline = ack ? setTimeout(() => fail('ack', ack.message), ack.withinMs) : undefined
    // Decoded as a stream: a character that arrives in two chunks is one character
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (d: string) => {
      if (settled) return
      stdout += d
      if (ack && stdout.includes(ack.marker)) clearTimeout(ackDeadline)
      if (stdout.length > stdoutLimit) fail('output', `ssh to ${opts.label} printed more than ${stdoutLimit / 1024 / 1024} MiB`)
    })
    child.stderr!.on('data', (d: string) => stderr.push(d))
    // An ssh that could not start (ENOENT) emits no 'exit', only 'error' and 'close'
    child.once('error', (e) => fail('spawn', e.message))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(ackDeadline)
      resolve({ code, stdout, stderr: stderr.text })
    })
  })
}
