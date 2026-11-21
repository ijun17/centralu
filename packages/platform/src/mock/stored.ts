/** A JSON value in localStorage; storage missing (node), denied, or not JSON reads as `undefined` */
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
