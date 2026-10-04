import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const handlers = new Map<string, (e: { payload: unknown }) => void>()
const unlistened: string[] = []
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb)
    return () => unlistened.push(name)
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
