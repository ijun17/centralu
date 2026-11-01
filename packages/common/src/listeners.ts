/**
 * A set of subscribers: `add` returns the function that removes it, `emit` hands one value to every subscriber.
 *
 * Each subscriber is isolated: one that throws is reported to `onError` and the rest still get the value, because the
 * sender has already moved past it and nothing would hand it over again. `emit` walks a snapshot, so a subscriber that
 * adds or removes one (itself included) while the value is going round neither skips nor repeats another.
 */
export type Listeners<T> = {
  add(listener: (value: T) => void): () => void
  emit(value: T): void
  clear(): void
  readonly size: number
}

export function createListeners<T = void>(onError: (error: unknown) => void): Listeners<T> {
  const all = new Set<(value: T) => void>()
  return {
    add(listener) {
      all.add(listener)
      return () => void all.delete(listener)
    },
    emit(value) {
      for (const l of [...all]) {
        try {
          l(value)
        } catch (e) {
          onError(e)
        }
      }
    },
    clear: () => all.clear(),
    get size() {
      return all.size
    },
  }
}
