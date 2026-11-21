import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../../tooling/fixtures/host-lock-store-work.json'

const invoke = vi.fn()
const handlers = new Map<string, (e: { payload: unknown }) => void>()
const unlistened: string[] = []
/** Every listener still registered, in order — `handlers` keeps only the last one per event */
const listeners: { name: string; cb: (e: { payload: unknown }) => void }[] = []
const fire = (name: string, payload: unknown) => {
  for (const l of listeners.filter((x) => x.name === name)) l.cb({ payload })
}
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb)
    const entry = { name, cb }
    listeners.push(entry)
    return () => {
      listeners.splice(listeners.indexOf(entry), 1)
      unlistened.push(name)
    }
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const { createTauriPlatform, listenForQuit, quitApp } = await import('./index.js')

/**
 * The desktop when the host fails to come up: the seam with the shell only. That ⌘Q works and Retry brings the host
 * back is checked by hand in the packaged app.
 */
beforeEach(() => {
  invoke.mockReset()
  handlers.clear()
  unlistened.length = 0
  listeners.length = 0
})

describe('the receiver for a quit request', () => {
  it('quits right away if there is nothing to ask (the startup or startup-failure screen), and hands off to it if something is up', async () => {
    const setAsker = listenForQuit()
    await vi.waitFor(() => expect(handlers.has('quit-requested')).toBe(true))
    const quit = handlers.get('quit-requested')!

    quit({ payload: null })
    expect(invoke).toHaveBeenCalledWith('quit_app')

    invoke.mockClear()
    const ask = vi.fn()
    setAsker(ask)
    quit({ payload: null })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()

    setAsker(null)
    quit({ payload: null })
    expect(invoke).toHaveBeenCalledWith('quit_app')
  })
})

describe('quitting (#1009)', () => {
  it('a quit the shell refuses is an Error carrying its reason', async () => {
    invoke.mockRejectedValue('quit refused')
    const err = await quitApp().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('quit refused')
  })
})

describe('waiting for the host', () => {
  it('even if the event is missed, immediately reads the failure message the supervisor left and fails — does not wait out the 30 seconds', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'host_info') return null
      if (cmd === 'host_error') return 'Could not find Node.js'
      return null
    })
    await expect(createTauriPlatform()).rejects.toThrow('Could not find Node.js')
    // Subscriptions do not pile up on every retry
    await vi.waitFor(() => expect(unlistened).toContain('host-status'))
  })
})

describe('a host that works on its store before it answers (#2334)', () => {
  it('is waited for past the 30 seconds while the shell reports the work, which the screen is told, and then the wait is the usual one', async () => {
    vi.useFakeTimers()
    try {
      // What the shell reads from host.lock, as the host writes it (tooling/fixtures/host-lock-store-work.json)
      const work = (JSON.parse(fixture.record) as { store: unknown }).store
      let working = true
      let ready = false
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'host_info') return ready ? { port: 1, token: 't' } : null
        if (cmd === 'host_store_work') return working ? work : null
        return null
      })
      const told: unknown[] = []
      let settled = false
      const platform = createTauriPlatform({ onStoreWork: (w) => void told.push(w) }).finally(() => (settled = true))
      // Without the store-work wait: rejected at 30 s with "agent-host did not become ready in time", the copy still running
      await vi.advanceTimersByTimeAsync(90_000)
      expect(settled).toBe(false)
      // Once for the work, not once per check (the screen's clock is reset by each)
      expect(told).toEqual([work])

      working = false
      await vi.advanceTimersByTimeAsync(1_000)
      expect(told).toEqual([work, null])
      ready = true
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settled).toBe(true)
      vi.useRealTimers()
      const p = await platform
      await p.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a report that is not one is no work: the screen is told none, and the usual wait ends the start', async () => {
    vi.useFakeTimers()
    try {
      invoke.mockImplementation(async (cmd: string) => (cmd === 'host_store_work' ? { doing: 'copy', step: '76' } : null))
      const told: unknown[] = []
      const failed = createTauriPlatform({ onStoreWork: (w) => void told.push(w) }).catch((e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(await failed).toBe('agent-host did not become ready in time')
      expect(told).toEqual([null])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('background mode (#280)', () => {
  const shell = (mode: 'keeper' | 'direct') =>
    invoke.mockImplementation(async (cmd: string, args?: { on?: boolean }) => {
      if (cmd === 'host_info') return { port: 1, token: 't' }
      if (cmd === 'host_error') return null
      if (cmd === 'host_build') return { mode }
      if (cmd === 'background_mode') return false
      if (cmd === 'set_background_mode') return args?.on
      return null
    })

  it('is offered when the keeper holds the host, and goes through the shell', async () => {
    shell('keeper')
    const p = await createTauriPlatform()
    try {
      expect(p.background).toBeDefined()
      expect(await p.background!.set(true)).toBe(true)
      expect(invoke).toHaveBeenCalledWith('set_background_mode', { on: true })
    } finally {
      await p.dispose()
    }
  })

  /** A switch that cannot work must not be shown: with no keeper, nothing outlives the window */
  it('is not offered when the app runs the host itself', async () => {
    shell('direct')
    const p = await createTauriPlatform()
    try {
      expect(p.background).toBeUndefined()
    } finally {
      await p.dispose()
    }
  })
})


describe('a host restart during startup (#972 item 1)', () => {
  it('is followed: a ready for a new port between reading host_info and the web platform subscribing moves the client there', async () => {
    const urls: string[] = []
    class FakeSocket {
      onopen: (() => void) | null = null
      onmessage: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(url: string) {
        urls.push(url)
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'host_info') return { port: 1, token: 't' }
      if (cmd === 'host_error') return null
      if (cmd === 'host_build') return { mode: 'direct' }
      // The supervisor restarts the host while startup is still asking the shell about the window
      if (cmd === 'window_controls_inset') fire('host-status', { state: 'ready', port: 2, token: 'u' })
      return null
    })
    try {
      const p = await createTauriPlatform()
      try {
        expect(urls).toEqual(['ws://127.0.0.1:1/', 'ws://127.0.0.1:2/'])
        // The shell repeats ready for the same host (keeper mode, on every change of its view): no new socket
        fire('host-status', { state: 'ready', port: 2, token: 'u' })
        expect(urls).toEqual(['ws://127.0.0.1:1/', 'ws://127.0.0.1:2/'])
      } finally {
        await p.dispose()
      }
      // The startup subscription goes with the platform
      expect(listeners.filter((l) => l.name === 'host-status')).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
