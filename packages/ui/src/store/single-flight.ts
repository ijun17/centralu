import type { Platform } from '@cc/platform/ports'
import type { StoreGet } from './state.js'

type Reading = { platform: Platform; again: boolean; done: Promise<void> }
const reading = new Map<string, Reading>()

/**
 * One read of a host list at a time, plus one more if asked meanwhile, so an older answer never overwrites a newer one.
 * Keyed by platform too: a read that finishes after `attach` swapped the platform writes nothing.
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
