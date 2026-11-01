import type { OsChild, OsClock, OsFiles, OsProcesses, RunOptions, RunResult } from './port.js'

/** How long a run waits for its output to close once the program has exited: a grandchild may hold the pipes (git-exec.ts) */
export const CLOSE_AFTER_EXIT_MS = 1000

/** The grace a run gives a tree it ends (a timeout, an overflow, an abort) before the second shot */
export const RUN_STOP_GRACE_MS = 2000

/**
 * A program run to its end (`OsProcesses.run`, `runShell`), for the real OS and the in-memory one alike: the one
 * definition of what a run is. `start` starts the child with stdio `[input ? 'pipe' : 'ignore', stdout, 'pipe']`.
 *
 * Settles with the output once the child's output has closed, or `CLOSE_AFTER_EXIT_MS` after it exited when something
 * it started still holds the pipes. A timeout, an overflow past `maxBuffer` or an abort ends the whole tree
 * (`stop`), and the result says which (`ended`). Rejects only when the program could not be started.
 */
export function runChild(
  os: {
    processes: Pick<OsProcesses, 'stop'>
    clock: OsClock
    files: Pick<OsFiles, 'openSync' | 'closeSync'>
  },
  start: (stdio: ['pipe' | 'ignore', 'pipe' | number, 'pipe']) => OsChild,
  options: Omit<RunOptions, 'cwd' | 'env'> = {},
): Promise<RunResult> {
  const fd = options.stdoutFile === undefined ? undefined : os.files.openSync(options.stdoutFile, 'w', 0o600)
  let child: OsChild
  try {
    child = start([options.input === undefined ? 'ignore' : 'pipe', fd ?? 'pipe', 'pipe'])
  } finally {
    // The child has its own copy of the file now
    if (fd !== undefined) os.files.closeSync(fd)
  }
  options.onChild?.(child)
  return new Promise<RunResult>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let ended: RunResult['ended']
    let settled = false
    const timers: Array<{ cancel(): void }> = []
    const stopFor = (why: NonNullable<RunResult['ended']>) => {
      if (ended || settled) return
      ended = why
      // Ended because the reader had enough: its group went with it, and a sweep for leftovers would only cost a listing
      void os.processes.stop(child, options.stopGraceMs ?? RUN_STOP_GRACE_MS, { sweep: why !== 'stopped' }).catch(() => {})
    }
    // Not once the program has exited: what it did then is done, and the answer is its own
    const onAbort = () => {
      if (child.exitCode === null && child.signalCode === null) stopFor('aborted')
    }
    const done = (finish: () => void) => {
      if (settled) return
      settled = true
      for (const t of timers) t.cancel()
      options.signal?.removeEventListener('abort', onAbort)
      // A program the run no longer waits for may still hold the pipes: let go of them
      child.stdout?.destroy()
      child.stderr?.destroy()
      finish()
    }
    // Each stream counted on its own, as `maxBuffer` says; past it, the rest is dropped while the tree ends
    const collect = (into: Buffer[]) => {
      let bytes = 0
      return (chunk: Buffer | string) => {
        if (ended === 'overflow') return
        const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        into.push(b)
        bytes += b.length
        if (options.maxBuffer !== undefined && bytes > options.maxBuffer) stopFor('overflow')
      }
    }
    // Kept in part (`stderrKeep`): the first or the last bytes, never an overflow
    const keep = (into: Buffer[], { bytes: limit, from }: NonNullable<RunOptions['stderrKeep']>) => {
      let kept = 0
      return (chunk: Buffer | string) => {
        const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        if (limit <= 0) return
        if (from === 'head') {
          if (kept >= limit) return
          into.push(b.subarray(0, limit - kept))
          kept += Math.min(b.length, limit - kept)
          return
        }
        into.push(b)
        kept += b.length
        while (into.length > 1 && kept - (into[0]?.length ?? 0) >= limit) kept -= into.shift()?.length ?? 0
      }
    }
    const handOver = (chunk: Buffer | string) => {
      if (ended) return
      if (options.onStdout?.(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) stopFor('stopped')
    }
    child.stdout?.on('data', options.onStdout ? handOver : collect(stdout))
    child.stderr?.on('data', options.stderrKeep ? keep(stderr, options.stderrKeep) : collect(stderr))
    const result = (code: number | null, signal: NodeJS.Signals | null): RunResult => {
      const err = Buffer.concat(stderr)
      const tailBytes = options.stderrKeep?.from === 'tail' ? options.stderrKeep.bytes : undefined
      return {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: tailBytes === undefined ? err : err.subarray(Math.max(0, err.length - tailBytes)),
        ...(ended ? { ended } : {}),
      }
    }
    child.once('error', (error) => {
      if (child.pid === undefined) done(() => reject(error))
    })
    child.once('exit', (code, signal) => {
      timers.push(os.clock.setTimeout(() => done(() => resolve(result(code, signal))), CLOSE_AFTER_EXIT_MS))
    })
    child.once('close', (code, signal) => done(() => resolve(result(code, signal))))
    if (options.timeoutMs !== undefined)
      timers.push(os.clock.setTimeout(() => stopFor('timeout'), options.timeoutMs))
    if (options.signal) {
      if (options.signal.aborted) stopFor('aborted')
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // The program ended without reading it all (EPIPE): its exit says what happened
      })
      child.stdin.end(options.input)
    }
  })
}
