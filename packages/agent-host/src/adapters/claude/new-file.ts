import { stat } from 'node:fs/promises'
import { raceTimeout } from '../../timing.js'

/**
 * Whether a path names no file yet, for a Write's approval card (#843): true when nothing is there, false when
 * something is, undefined when that is not known within a short bound. The path is the agent's, and a sync check on a
 * slow or network mount would hold every session in this host while it waited.
 */
export async function newFile(path: string, statOf: (path: string) => Promise<unknown> = stat): Promise<boolean | undefined> {
  const found = statOf(path).then(
    () => false,
    (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? true : undefined),
  )
  return raceTimeout(found, NEW_FILE_CHECK_MS, undefined)
}

/** How long a Write's card waits to learn whether its file is there before it says "writes the whole file" */
const NEW_FILE_CHECK_MS = 300
