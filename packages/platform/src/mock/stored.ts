/**
 * A JSON value kept in localStorage, which may be missing (node), denied, or hold text that is not JSON: every such
 * case reads as nothing and writes as nothing. `undefined` is "nothing stored or readable".
 */
export function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

/** Keeps `value` under `key`; a page without storage, or with it denied, keeps nothing and says nothing */
export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* no storage, or denied: the caller's in-memory copy still serves */
  }
}
