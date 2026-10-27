// The short cache the board and the reader's threads share (pure: no gh, no IO of its own).
import { now as clock } from './clock.mjs'

/**
 * Reads from GitHub kept in memory for `ttlMs`, at most `max` keys (the oldest read goes first). A
 * write forgets its key (`forget`), and a read that started before the write never refills it (the
 * key's generation), so a tool never answers from a read older than its own last write. A read asked
 * for while one of the same generation is under way shares it, `fresh` or not. `keep` says whether a
 * value is worth keeping (a thread that is not there is asked again next time).
 */
export function freshCache({ ttlMs, max = Infinity, keep = () => true }) {
  const entries = new Map() // key → { at, value }, oldest first
  const reads = new Map() // key → { generation, promise }
  const generations = new Map() // key → how many writes forgot it
  const generationOf = (key) => generations.get(key) ?? 0
  return {
    /** The value under `key`, from the cache or from `read()`; `fresh` skips the cache. */
    async get(key, read, { fresh = false } = {}) {
      const hit = entries.get(key)
      if (!fresh && hit && clock() - hit.at < ttlMs) return hit.value
      const generation = generationOf(key)
      const pending = reads.get(key)
      if (pending && pending.generation === generation) return pending.promise
      const promise = read().then((value) => {
        if (keep(value) && generationOf(key) === generation) {
          entries.delete(key)
          entries.set(key, { at: clock(), value })
          while (entries.size > max) entries.delete(entries.keys().next().value)
        }
        return value
      })
      reads.set(key, { generation, promise })
      promise
        .finally(() => {
          if (reads.get(key)?.promise === promise) reads.delete(key)
        })
        .catch(() => {})
      return promise
    },
    /** Drops `key`; a read under way when this is called will not refill it. */
    forget(key) {
      entries.delete(key)
      generations.set(key, generationOf(key) + 1)
    },
  }
}
