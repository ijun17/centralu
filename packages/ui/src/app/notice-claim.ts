/**
 * Whether this window is the one that raises the notification for an event (#2168). Every window hears the host's
 * events, so with two open each raised its own banner and sound for one mail or approval. The windows of one machine
 * share their origin's IndexedDB (the desktop app's windows, a browser's tabs), whose `add` of a key already there fails
 * in every connection alike: the window whose `add` succeeds raises it, and the others leave it. So it is once per
 * machine, as the person sees it. (localStorage would not do: another process sees a write a moment later.)
 *
 * A key is kept `KEPT_MS`, so an event replayed after a reconnect is not raised again either. A page without IndexedDB,
 * or one that fails or does not answer within `CLAIM_BOUND_MS` (a test in Node, storage denied, a hung database), cannot
 * tell, and every window raises its own, as before: a notification twice rather than none.
 */
const DB = 'centralu-notices'
const STORE = 'raised'
const KEPT_MS = 10 * 60_000

let opened: Promise<IDBDatabase> | null = null

function database(idb: IDBFactory): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE).createIndex('at', '')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB did not open'))
  }).catch((e: unknown) => {
    opened = null
    throw e
  })
  return opened
}

/**
 * How long a claim may take before the window raises the notification anyway: a claim answers in milliseconds, and an
 * IndexedDB that never answers (a hung open, a transaction that never settles) must not silence every window's
 */
export const CLAIM_BOUND_MS = 500

export function firstToRaise(key: string): Promise<boolean> {
  const idb = globalThis.indexedDB
  if (!idb) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), CLAIM_BOUND_MS)
    void claim(idb, key).then((first) => {
      clearTimeout(timer)
      resolve(first)
    })
  })
}

async function claim(idb: IDBFactory, key: string): Promise<boolean> {
  try {
    const db = await database(idb)
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const now = Date.now()
      const old = store.index('at').openCursor(IDBKeyRange.upperBound(now - KEPT_MS))
      old.onsuccess = () => {
        const cursor = old.result
        if (!cursor) return
        cursor.delete()
        cursor.continue()
      }
      const add = store.add(now, key)
      add.onsuccess = () => resolve(true)
      add.onerror = (e) => {
        // Another window took it: the transaction goes on (the old keys still go)
        e.preventDefault()
        resolve(add.error?.name !== 'ConstraintError')
      }
    })
  } catch {
    return true
  }
}
