import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The shell's two reports, `host-status` and `host-build` (#850 item 17). Tauri registers a listener
 * asynchronously, so a question asked before the registration lands can miss a report sent in between, and its
 * answer, arriving after a newer report, can put the older state back. The rule above `waitForHost` says
 * subscribe first, then ask; these check that every reader follows it.
 */
const order: string[] = []
const handlers = new Map<string, (e: { payload: unknown }) => void>()
let answerBuild: (b: unknown) => void = () => {}
let registered: () => void = () => {}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    order.push(`ask:${cmd}`)
    if (cmd === 'host_build') return new Promise((resolve) => (answerBuild = resolve))
    return Promise.resolve(null)
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    order.push(`listen:${name}`)
    return new Promise((resolve) => {
      registered = () => {
        handlers.set(name, cb)
        order.push(`registered:${name}`)
        resolve(() => handlers.delete(name))
      }
    })
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const { onHostStatus, tauriRelaunchPort, watchHostBuild } = await import('./index.js')

beforeEach(() => {
  order.length = 0
  handlers.clear()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('following the build report', () => {
  for (const [name, follow] of [
    ['watchHostBuild', (cb: (busy: boolean | null) => void) => watchHostBuild((b) => cb(b.busy ?? null))],
    ['the relaunch port’s watchBusy', (cb: (busy: boolean | null) => void) => tauriRelaunchPort().watchBusy(cb)],
  ] as const) {
    it(`${name} asks for the current report only once its listener is registered`, async () => {
      const seen: (boolean | null)[] = []
      const stop = follow((b) => seen.push(b))
      await flush()
      expect(order).not.toContain('ask:host_build')
      registered()
      await flush()
      expect(order).toEqual(['listen:host-build', 'registered:host-build', 'ask:host_build'])
      answerBuild({ mode: 'keeper', busy: false })
      await flush()
      expect(seen).toEqual([false])
      stop()
    })

    it(`${name} keeps a report that arrived before the answer to its question`, async () => {
      const seen: (boolean | null)[] = []
      const stop = follow((b) => seen.push(b))
      registered()
      await flush()
      handlers.get('host-build')!({ payload: { mode: 'keeper', busy: true } })
      // The answer was read before that report was sent: it is the older state
      answerBuild({ mode: 'keeper', busy: false })
      await flush()
      expect(seen).toEqual([true])
      stop()
    })
  }

  it('stops: nothing arrives after the unsubscribe, and the listener goes', async () => {
    const seen: unknown[] = []
    const stop = watchHostBuild((b) => seen.push(b))
    registered()
    await flush()
    stop()
    answerBuild({ mode: 'keeper' })
    await flush()
    expect(seen).toEqual([])
    expect(handlers.has('host-build')).toBe(false)
  })
})

describe('the status report', () => {
  it('passes on a status and drops a payload that is not one', async () => {
    const seen: unknown[] = []
    const stop = onHostStatus((s) => seen.push(s))
    registered()
    await flush()
    const send = handlers.get('host-status')!
    send({ payload: null })
    send({ payload: 'ready' })
    send({ payload: { state: 'ready', port: 1, token: 't' } })
    send({ payload: { state: 'failed', message: 'gone' } })
    expect(seen).toEqual([
      { state: 'ready', port: 1, token: 't' },
      { state: 'failed', message: 'gone' },
    ])
    stop()
    await flush()
    expect(handlers.has('host-status')).toBe(false)
  })
})
