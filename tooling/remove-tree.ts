import { readdir, rm } from 'node:fs/promises'

/**
 * How long a test's folder gets to be removed, in ms: Windows will not remove a folder a process still works in (EBUSY),
 * and the processes a test started can take that long to end. Inside a hook's time limit (30 s on Windows, 10 s elsewhere).
 */
export const REMOVE_WITHIN_MS = process.platform === 'win32' ? 20_000 : 5_000

/**
 * Removes a folder and everything in it, trying again until `ms` ms have passed, then fails naming what is left.
 *
 * One definition of every test folder removal (#1957): the tests' own folders, each test file's temporary folder and the
 * run's. `rm` with `maxRetries` is not used: it retries at every level of the tree, so its wait multiplies with depth (3
 * retries took 0.8 s for one level, 4.5 s for two, 19 s for three), a held folder ended in a hook timeout that named
 * nothing, and Node 20 and 22's synchronous one does not retry a held folder at all. This waits as long as it says.
 */
export async function removeWithin(dir: string, ms: number): Promise<void> {
  const until = Date.now() + ms
  for (let wait = 50; ; wait = Math.min(wait * 2, 500)) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (Date.now() + wait >= until) {
        const left = await readdir(dir).catch(() => [])
        const why = e instanceof Error ? e.message : String(e)
        throw Object.assign(new Error(`${dir} could not be removed within ${ms} ms (${why}); left in it: ${left.join(', ') || 'nothing seen'}`), { code: e instanceof Error && 'code' in e ? e.code : undefined, cause: e })
      }
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

/** `removeWithin` for a test's folder, by the time `REMOVE_WITHIN_MS` gives; one argument, so `.map(removeTree)` is safe */
export function removeTree(dir: string): Promise<void> {
  return removeWithin(dir, REMOVE_WITHIN_MS)
}
