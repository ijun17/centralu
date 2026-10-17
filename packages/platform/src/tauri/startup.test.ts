import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { createTauriPlatform, listenForQuit } = await import('./index.js')

/**
 * The desktop at the moment the host fails to come up (#184). Checks only the seam with the
 * shell, without a webview — whether ⌘Q actually works, and whether Retry actually brings the
 * host back up, is confirmed by hand in the packaged app.
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


describe('a relaunched window whose automatic swap fails', () => {
  it('creates a working platform on the attached host and records the startup attempt and error', async () => {
    const build = {
      mode: 'keeper', relaunched: true, sameBuild: false, keeperSameBuild: false, busy: false, keepsAgents: true,
      app: { version: `0.1.0-beta.${20}`, commit: 'new' },
      host: { version: `0.1.0-beta.${19}`, commit: 'old' },
      keeper: { version: `0.1.0-beta.${19}`, commit: 'old' },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'host_info') return { port: 1, token: 't' }
      if (cmd === 'host_error') return null
      if (cmd === 'host_build') return build
      if (cmd === 'switch_host_build') throw new Error('Keeper refused the handoff')
      return null
    })
    try {
      const platform = await createTauriPlatform()
      try {
        expect(platform.background).toBeDefined()
        expect(invoke.mock.calls.filter(([cmd]) => cmd === 'switch_host_build')).toHaveLength(1)
        expect(platform.relaunchSwap).toEqual({ tried: true, error: 'Keeper refused the handoff' })
        expect(unlistened).toContain('host-build')
      } finally { await platform.dispose() }
    } finally { warn.mockRestore() }
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
        expect(urls[0]).toBe('ws://127.0.0.1:1/')
        expect(urls.at(-1)).toBe('ws://127.0.0.1:2')
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
