import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const startDragging = vi.fn()
const openDialog = vi.fn()
const isPermissionGranted = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ startDragging: () => startDragging() }) }))
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => isPermissionGranted(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => openDialog(...args) }))

const { TauriSystemPort, pickDirectory } = await import('./index.js')

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
    startDragging.mockReset()
    openDialog.mockReset()
    isPermissionGranted.mockReset()
  })

  /*
   * #972 item 2: every call into the shell or a plugin rejects with an Error, so the screen's
   * `err.message` names the reason. Each of these used to pass the bare string through, and a
   * missing drag permission read "Could not move window: undefined".
   */
  const reasonOf = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    return (err as Error).message
  }

  it('a link taken from the shell after its listener unsubscribed goes to the next listener, not nowhere (#972 item 6)', async () => {
    let answer: (links: string[]) => void = () => {}
    invoke.mockImplementation((cmd: string) =>
      cmd === 'take_app_links' ? new Promise<string[]>((resolve) => (answer = resolve)) : Promise.resolve(null),
    )
    const port = new TauriSystemPort()
    const first: string[] = []
    const stop = port.onAppLink((l) => first.push(l))
    stop()
    answer(['centralu://import?source=x'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(first).toEqual([])
    const next: string[] = []
    const stopNext = port.onAppLink((l) => next.push(l))
    expect(next).toEqual(['centralu://import?source=x'])
    stopNext()
  })

  it('a link taken for a listener that left goes to a listener on another port that joined meanwhile (#1010 review)', async () => {
    let answer: (links: string[]) => void = () => {}
    invoke.mockImplementation((cmd: string) =>
      cmd === 'take_app_links' ? new Promise<string[]>((resolve) => (answer = resolve)) : Promise.resolve(null),
    )
    const stop = new TauriSystemPort().onAppLink(() => {})
    const first = answer
    const later: string[] = []
    // A platform made again: a new port, whose own first take answers nothing
    new TauriSystemPort().onAppLink((l) => later.push(l))
    answer([])
    stop()
    first(['centralu://import?source=y'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(later).toEqual(['centralu://import?source=y'])
  })

  it('a failed window drag is an Error carrying the reason', async () => {
    startDragging.mockRejectedValue('window.start_dragging not allowed')
    expect(await reasonOf(new TauriSystemPort().startWindowDrag())).toBe('window.start_dragging not allowed')
  })

  it('a failed sound-and-dock alert and badge are Errors carrying the reason', async () => {
    invoke.mockRejectedValue('no dock here')
    expect(await reasonOf(new TauriSystemPort().alert('done', true))).toBe('no dock here')
    expect(await reasonOf(new TauriSystemPort().setBadge(2))).toBe('no dock here')
  })

  it('a notification plugin that fails is an Error carrying the reason', async () => {
    isPermissionGranted.mockRejectedValue('notification plugin missing')
    expect(await reasonOf(new TauriSystemPort().notify('t', 'b'))).toBe('notification plugin missing')
  })

  it('a picker that fails is an Error carrying the reason, for files and directories alike', async () => {
    openDialog.mockRejectedValue('dialog.open not allowed')
    expect(await reasonOf(new TauriSystemPort().pickFile({ title: 'Choose', extensions: ['zip'] }))).toBe('dialog.open not allowed')
    expect(await reasonOf(new TauriSystemPort().pickDirectory())).toBe('dialog.open not allowed')
    expect(await reasonOf(pickDirectory())).toBe('dialog.open not allowed')
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
