/**
 * Whether a process with this pid exists, for tests that wait on processes they started (#845).
 *
 * EPERM means it exists: the signal check found the process and was refused because it belongs to someone else (a
 * pid reused by another user's process on macOS and Linux, a protected one on Windows). Half of the copies this
 * replaces read EPERM as gone, so a cleanup moved on to removing a folder that a survivor it could not signal still
 * held; the other half read it as alive.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * What a test may still end by its pid (#1308). A pid names a process only while that process runs: once the test has
 * seen it end, the number is free, and on Windows `process.kill` on a number someone else has since been given is
 * TerminateProcess (exit 1) on their program: a cleanup that checks `alive(pid)` first cannot tell the two apart. So a
 * cleanup ends only the pids this ledger has not seen end, and a test reports every end it sees through `alive` or
 * `sawEnd`.
 *
 * The ledger knows only the ends the test looked at. A cleanup that runs after the code under test was asked to stop
 * the processes (a `dispose()`, a `stop()`) has not looked: use `endAfter`, which looks first, and do not call `end`
 * there.
 *
 * Where the test holds the `ChildProcess` it spawned, call `kill` on that instead: Node sends nothing after the child
 * has exited. This is for what the test has only a number of (a grandchild, a pid read from a file).
 *
 * `isAlive` is a parameter so a test can stand for a number that was freed and given to another process.
 */
export function ownProcesses(isAlive: (pid: number) => boolean = alive) {
  const seenEnd = new Set<number>()
  return {
    /** Whether the process exists; a pid found gone is not this test's to signal from now on, whatever answers to it later */
    alive(pid: number): boolean {
      const here = isAlive(pid)
      if (!here) seenEnd.add(pid)
      return here
    },
    /** The test saw the process end by other means (the 'exit' event of its handle, the end of a wait) */
    sawEnd(pid: number): void {
      seenEnd.add(pid)
    },
    /**
     * For a cleanup that runs after the code under test was asked to stop these processes: first looks, for up to `ms`,
     * until each is gone (recording the ends it sees), then ends only what is still there. A process that is gone by
     * then is not signalled, however long ago it went; a test that passed pays no wait beyond the stop itself.
     */
    async endAfter(pids: Iterable<number>, ms: number, opts: { signal?: NodeJS.Signals; group?: boolean } = {}): Promise<void> {
      const list = [...pids].filter((pid) => pid > 0)
      const deadline = Date.now() + ms
      const left = () => list.filter((pid) => !seenEnd.has(pid) && this.alive(pid))
      while (left().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
      this.end(list, opts)
    },
    /**
     * Signals every pid whose end the test has not seen (SIGKILL by default; `group` signals the process group, POSIX
     * only). A pid already gone is ignored, so this never throws.
     */
    end(pids: Iterable<number>, opts: { signal?: NodeJS.Signals; group?: boolean } = {}): void {
      for (const pid of pids) {
        if (!(pid > 0) || seenEnd.has(pid)) continue
        try {
          process.kill(opts.group ? -pid : pid, opts.signal ?? 'SIGKILL')
        } catch {
          // already gone
        }
      }
    },
    /** Starts these pids afresh, for a ledger that outlives one test: the next process to get such a number is new */
    forget(pids: Iterable<number>): void {
      for (const pid of pids) seenEnd.delete(pid)
    },
  }
}
