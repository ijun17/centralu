import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebPlatform } from './index.js'

// No socket is opened: only the browser's system port is under test
class UnconnectedSocket {
  close() {}
}

const platform = () => createWebPlatform({ token: 'test', WebSocketImpl: UnconnectedSocket as unknown as typeof WebSocket })

/**
 * The browser's system port says when it could not do something (#972 item 5). It used to resolve as if the IDE had
 * opened, the tab had opened behind a pop-up blocker, or the notification had been shown with no permission asked.
 */
describe('the web system port', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('Open in IDE is refused with where to go instead', async () => {
    const p = platform()
    await expect(p.system.openInIde('/tmp/a.ts', 3)).rejects.toThrow('use the desktop app')
    await p.dispose()
  })

  it('a link opens in a new tab cut off from this page, and a blocked pop-up is refused', async () => {
    const tab = { opener: {} as unknown }
    const open = vi.fn().mockReturnValueOnce(tab).mockReturnValueOnce(null)
    vi.stubGlobal('window', { open })
    const p = platform()
    await p.system.openUrl('https://example.com/')
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank')
    expect(tab.opener).toBeNull()
    await expect(p.system.openUrl('https://example.com/')).rejects.toThrow('blocked the new tab')
    await p.dispose()
  })

  it('a notification asks for permission first, and says once when it is not allowed', async () => {
    const shown: string[] = []
    const requestPermission = vi.fn(async () => 'granted')
    class FakeNotification {
      static permission = 'default'
      static requestPermission = requestPermission
      constructor(title: string) {
        shown.push(title)
      }
    }
    vi.stubGlobal('Notification', FakeNotification)
    const p = platform()
    await p.system.notify('done', 'body')
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(shown).toEqual(['done'])

    FakeNotification.permission = 'denied'
    await expect(p.system.notify('again', 'body')).rejects.toThrow('blocked for this page')
    // Said once, not on every notice
    await expect(p.system.notify('third', 'body')).resolves.toBeUndefined()
    expect(shown).toEqual(['done'])
    await p.dispose()
  })
})
