import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_VERSION, PROTOCOL_VERSION } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { Links } from './links.js'
import { storeMirror, storeRegistry } from './stored.js'
import type { Tunnel } from './tunnel.js'

/**
 * How often the hub tries a machine it cannot reach (#1134): from 2 s, doubling, up to 5 minutes. A laptop that is
 * closed, or a server used once a week, used to cost an ssh attempt every minute for as long as the hub ran.
 */

afterEach(() => {
  vi.useRealTimers()
})

/** A tunnel to a machine that is never there, noting when each attempt was made */
function awayTunnel(at: number[]): Tunnel {
  return {
    open: async () => {
      at.push(Date.now())
      throw new Error('ssh: connect to host box port 22: Operation timed out')
    },
    onDown: () => {},
    close: async () => {},
  }
}

describe('a linked machine that cannot be reached (#1134)', () => {
  it('is tried again from 2 s, doubling, until the attempts are 5 minutes apart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const store = new Store()
    const registry = storeRegistry(store)
    registry.add({ id: 'm1', name: 'Laptop', sshTarget: 'laptop', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    const at: number[] = []
    // No `retryMs`: the backoff the host runs with
    const links = new Links({
      hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: false },
      broadcast: () => {},
      terminal: () => {},
      mirror: storeMirror(store),
      registry,
      tunnelFor: () => awayTunnel(at),
    })
    links.start()
    // 2+4+…+256 s, then three steps at the cap
    await vi.advanceTimersByTimeAsync((2 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 3 * 300) * 1000)
    await links.stop()
    store.close()

    const gaps = at.slice(1).map((t, i) => Math.round((t - at[i]!) / 1000))
    expect(gaps).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300])
    // A connect that times out is a machine that does not answer, shown as away between the attempts (#1398)
    expect(links.list()[0]).toMatchObject({ status: 'away' })
  })
})
