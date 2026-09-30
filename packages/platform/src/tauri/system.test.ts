import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const { TauriSystemPort } = await import('./index.js')

/**
 * The seam between the desktop system port and the Rust commands (#159).
 *
 * There is no way to see the packaged app's behavior without a webview, so this only checks
 * **what gets called, and the shape a failure comes back in.** Whether a browser and VS Code
 * actually open is confirmed by hand in the packaged app.
 */
describe('TauriSystemPort', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('opens a link with the opener plugin\'s open_url — window.open opens nothing in the desktop webview', async () => {
    invoke.mockResolvedValue(undefined)
    await new TauriSystemPort().openUrl('https://example.com/')
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'https://example.com/' })
  })

  it('a failure from Open in IDE is an Error whose message is the reason Rust gave — not "undefined"', async () => {
    invoke.mockRejectedValue("VS Code's `code` command was not found (looked in: /usr/bin/code)")
    const err = await new TauriSystemPort().openInIde('/tmp/a.ts', 3).catch((e: unknown) => e)
    expect(invoke).toHaveBeenCalledWith('open_in_ide', { path: '/tmp/a.ts', line: 3 })
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("VS Code's `code` command was not found (looked in: /usr/bin/code)")
  })

  it('also throws an Error carrying the reason when a link could not be opened', async () => {
    invoke.mockRejectedValue('Not allowed to open url file:///etc/passwd')
    const err = await new TauriSystemPort().openUrl('file:///etc/passwd').catch((e: unknown) => e)
    expect((err as Error).message).toBe('Not allowed to open url file:///etc/passwd')
  })
})
