import type { Platform } from '@cc/platform/ports'
import type { StoreGet } from './state.js'

/** The read of one list now running: for which platform, and whether another ask came in meanwhile */
type Reading = { platform: Platform; again: boolean; done: Promise<void> }
const reading = new Map<string, Reading>()

/**
 * Re-reads a list the host announces changes of: one read at a time, and once more afterwards if another ask came in
 * meanwhile, so reads never land out of order and an older answer never overwrites a newer one. An ask during a read
 * waits for that read and the one after it.
 *
 * Keyed by `key` and by the platform: a read that finishes after `attach` swapped the platform writes nothing, and the
 * new platform's ask starts its own read rather than being handed the old one's. A read that fails leaves the list as it
 * was; the next change or reconnect reads again.
 *
 * @param apply writes what was read; true asks for one more read (a value it had to withhold)
 */
export function coalescedRead<T>(
  key: string,
  get: StoreGet,
  read: (platform: Platform) => Promise<T>,
  apply: (value: T) => boolean | void,
): Promise<void> {
  const platform = get().platform
  if (!platform) return Promise.resolve()
  const running = reading.get(key)
  if (running?.platform === platform) {
    running.again = true
    return running.done
  }
  const mine: Reading = { platform, again: false, done: Promise.resolve() }
  reading.set(key, mine)
  mine.done = (async () => {
    try {
      do {
        mine.again = false
        try {
          const value = await read(platform)
          if (get().platform !== platform) return
          if (apply(value)) mine.again = true
        } catch {
          /* the old list stays */
        }
      } while (mine.again)
    } finally {
      if (reading.get(key) === mine) reading.delete(key)
    }
  })()
  return mine.done
}
