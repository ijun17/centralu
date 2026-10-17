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
