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
      if (cmd === 'host_error') return 'Node.js를 찾지 못했습니다'
      return null
    })
    await expect(createTauriPlatform()).rejects.toThrow('Node.js를 찾지 못했습니다')
    // Subscriptions do not pile up on every retry
    await vi.waitFor(() => expect(unlistened).toContain('host-status'))
  })
})
