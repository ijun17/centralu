import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAIM_BOUND_MS } from './notice-claim.js'

/**
 * The claim that one window of the machine raises a notification (#2168). Which window wins is checked with two pages
 * in e2e/notifications-windows.spec.ts; here, what a window does when IndexedDB cannot tell it.
 */
// The window's connection is the module's: each test starts with a window that has opened none
let firstToRaise: (key: string) => Promise<boolean>
beforeEach(async () => {
  vi.resetModules()
  ;({ firstToRaise } = await import('./notice-claim.js'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * An origin's database as every connection to it sees it: one set of keys, whose `add` of a key already there fails.
 * `fail` makes the next open fail; `close` is the browser closing a connection, as it does when storage is cleared
 */
function origin() {
  const keys = new Set<string>()
  const connections: { closed: boolean; onclose: (() => void) | null }[] = []
  let fail = false
  const later = (f: () => void) => void Promise.resolve().then(f)
  const request = (settle: (req: Record<string, any>) => void) => {
    const req: Record<string, any> = {}
    later(() => settle(req))
    return req
  }
  const store = {
    index: () => ({ openCursor: () => request((r) => ((r.result = null), r.onsuccess?.())) }),
    add: (_at: number, key: string) =>
      request((r) => {
        if (!keys.has(key)) return keys.add(key), r.onsuccess?.()
        r.error = { name: 'ConstraintError' }
        r.onerror?.({ preventDefault: () => {} })
      }),
  }
  const indexedDB = {
    open: () =>
      request((r) => {
        if (fail) return (fail = false), r.onerror?.()
        const db = {
          closed: false,
          onclose: null as (() => void) | null,
          transaction: () => {
            if (db.closed) throw new DOMException('The database connection is closing.', 'InvalidStateError')
            return { objectStore: () => store }
          },
        }
        connections.push(db)
        r.result = db
        r.onsuccess?.()
      }),
  }
  vi.stubGlobal('indexedDB', indexedDB)
  vi.stubGlobal('IDBKeyRange', { upperBound: () => null })
  return {
    connections,
    failNextOpen: () => void (fail = true),
    close: () => {
      const db = connections.at(-1)!
      db.closed = true
      db.onclose?.()
    },
  }
}

describe('firstToRaise', () => {
  it('raises when there is no IndexedDB to claim in', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(await firstToRaise('mail:m1')).toBe(true)
  })

  it('raises after its bound when IndexedDB never answers, rather than silencing every window, and opens again for the next', async () => {
    vi.useFakeTimers()
    // An open whose request never succeeds nor fails: a hung database
    const opened: string[] = []
    vi.stubGlobal('indexedDB', { open: (name: string) => (opened.push(name), {}) })
    let answer: boolean | undefined
    void firstToRaise('mail:m1').then((a) => (answer = a))
    await vi.advanceTimersByTimeAsync(CLAIM_BOUND_MS - 1)
    expect(opened).toEqual(['centralu-notices'])
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBe(true)
    // The hung connection is not kept for the next claim to wait on: it opens again
    void firstToRaise('mail:m2')
    expect(opened).toEqual(['centralu-notices', 'centralu-notices'])
  })

  it('opens another connection once the browser closed its own, and still tells a claimed event from a new one', async () => {
    const db = origin()
    expect(await firstToRaise('mail:m1')).toBe(true)
    expect(await firstToRaise('mail:m1')).toBe(false)
    db.close()
    expect(await firstToRaise('mail:m1')).toBe(false)
    expect(await firstToRaise('mail:m2')).toBe(true)
    expect(db.connections).toHaveLength(2)
  })

  it('raises when the open fails, and opens again for the next claim', async () => {
    const db = origin()
    db.failNextOpen()
    expect(await firstToRaise('approval:s1:r1')).toBe(true)
    expect(db.connections).toHaveLength(0)
    expect(await firstToRaise('approval:s1:r1')).toBe(true)
    expect(await firstToRaise('approval:s1:r1')).toBe(false)
    expect(db.connections).toHaveLength(1)
  })
})
