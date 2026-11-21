/** localStorage missing (Node), denied or holding text that is not JSON reads as `undefined` and writes nothing */
export function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* no storage, or denied: the caller's in-memory copy still serves */
  }
}
