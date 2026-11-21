/**
 * Listeners of one value: one that throws goes to `onError` and the rest still get the value, as nothing would hand it
 * over again. `emit` walks a snapshot, so adding or removing one mid-emit neither skips nor repeats another.
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
