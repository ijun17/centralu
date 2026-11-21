/**
 * Once per machine (#2168): the windows share their origin's IndexedDB, and the one whose `add` of the event's key
 * succeeds raises the notification (not localStorage: another process sees a write a moment late). Kept `KEPT_MS`
 * against reconnect replays. No IndexedDB, a failure or `CLAIM_BOUND_MS` passed: every window raises, twice not none.
 */
const DB = 'centralu-notices'
const STORE = 'raised'
const KEPT_MS = 10 * 60_000

/** Dropped when it fails, the browser closes it (`onclose`) or a claim fails or times out: kept, it fails every claim */
let opened: Promise<IDBDatabase> | null = null

function database(idb: IDBFactory): Promise<IDBDatabase> {
  if (opened) return opened
  const connection = new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE).createIndex('at', '')
    req.onsuccess = () => {
      req.result.onclose = () => drop(connection)
      resolve(req.result)
    }
    req.onerror = () => reject(req.error ?? new Error('IndexedDB did not open'))
  })
  opened = connection
  return connection
}

function drop(connection: Promise<IDBDatabase>): void {
  if (opened === connection) opened = null
}

/** A claim answers in milliseconds; a hung IndexedDB must not silence every window's notification */
export const CLAIM_BOUND_MS = 500

export function firstToRaise(key: string): Promise<boolean> {
  const idb = globalThis.indexedDB
  if (!idb) return Promise.resolve(true)
  const connection = database(idb)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      drop(connection)
      resolve(true)
    }, CLAIM_BOUND_MS)
    void claim(connection, key).then((first) => {
      clearTimeout(timer)
      resolve(first)
    })
  })
}

async function claim(connection: Promise<IDBDatabase>, key: string): Promise<boolean> {
  try {
    const db = await connection
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
    drop(connection)
    return true
  }
}
