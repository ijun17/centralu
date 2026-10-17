import { execFile } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** How much the entries git ignores take on disk (`gitIgnoredEntries`): du where it runs, a file system walk elsewhere. */

/** How long measuring the ignored entries may take before the list goes without sizes */
const SIZE_BUDGET_MS = 5000

/** One call to du asks for all of them; keyed by the path without its trailing slash */
export async function duSizes(cwd: string, paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('du', ['-sk', ...paths], { cwd, timeout: SIZE_BUDGET_MS, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) =>
        // du exits non-zero if even one entry cannot be read — whatever it did print is used anyway
        stdout ? resolve(stdout) : reject(err),
      )
    })
    for (const line of out.split('\n')) {
      const [kb, ...rest] = line.split('\t')
      const p = rest.join('\t').trim()
      if (p && kb) sizes.set(p.replace(/\/$/, ''), Number(kb) * 1024)
    }
  } catch {
    // proceed without sizes
  }
  return sizes
}

/**
 * The same sizes read from the file system, where du is not run (`measuresWithDu`, Windows, #849): bytes in files, not
 * blocks on disk, and a link counts for nothing and is never followed. An entry not finished within the budget has
 * no size, as one du did not reach.
 */
export async function walkedSizes(cwd: string, paths: string[]): Promise<Map<string, number>> {
  const deadline = Date.now() + SIZE_BUDGET_MS
  const sizes = new Map<string, number>()
  for (const path of paths) {
    const key = path.replace(/\/$/, '')
    const bytes = await treeBytes(resolve(cwd, key), deadline)
    if (bytes !== null) sizes.set(key, bytes)
  }
  return sizes
}

/** How many lstat calls the size walk has in flight at once, and how many entries it reads before giving up */
const SIZE_BATCH = 256
const MAX_SIZED_ENTRIES = 1_000_000

/**
 * The bytes under `path`, or null past `deadline` or past `maxEntries` entries. The files of one folder are measured
 * SIZE_BATCH at a time, with the deadline checked between batches: one folder of a million files used to queue a
 * million lstat calls at once (#849 review). A link counts as nothing and is not asked about: `lstat` follows one
 * whose target libuv cannot read, and following it could reach anywhere.
 */
export async function treeBytes(path: string, deadline: number, maxEntries: number = MAX_SIZED_ENTRIES): Promise<number | null> {
  const top = await lstat(path).catch(() => null)
  if (!top) return null
  if (!top.isDirectory()) return top.size
  let total = 0
  let seen = 0
  const folders = [path]
  while (folders.length > 0) {
    if (Date.now() > deadline) return null
    const folder = folders.pop()!
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    seen += entries.length
    if (seen > maxEntries) return null
    const files: string[] = []
    for (const entry of entries) {
      // A junction or symlink is neither: it is not walked into
      if (entry.isDirectory()) folders.push(join(folder, entry.name))
      else if (!entry.isSymbolicLink()) files.push(join(folder, entry.name))
    }
    for (let i = 0; i < files.length; i += SIZE_BATCH) {
      if (Date.now() > deadline) return null
      const each = await Promise.all(files.slice(i, i + SIZE_BATCH).map((file) => lstat(file).then((s) => s.size, () => 0)))
      for (const bytes of each) total += bytes
    }
  }
  return total
}
