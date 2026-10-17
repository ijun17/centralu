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

  /** A browser's Notification, its answer to a request set by the test */
  const fakeNotifications = (answer: 'granted' | 'denied' | null) => {
    const shown: string[] = []
    class FakeNotification {
      static permission = 'default'
      // null: the browser refuses a request outside a gesture and leaves the permission undecided
      static requestPermission = vi.fn(async () => {
        if (answer) FakeNotification.permission = answer
        return FakeNotification.permission
      })
      constructor(title: string) {
        shown.push(title)
      }
    }
    vi.stubGlobal('Notification', FakeNotification)
    return { shown, FakeNotification }
  }
  /** The port of a fresh page: whether a page has asked is the page's */
  const freshPlatform = async () => {
    vi.resetModules()
    const { createWebPlatform: create } = await import('./index.js')
    return () => create({ token: 'test', WebSocketImpl: UnconnectedSocket as unknown as typeof WebSocket })
  }

  it('asks once a page, only while undecided, and an undecided answer is not called blocked (#1010 review)', async () => {
    const { shown, FakeNotification } = fakeNotifications(null)
    const make = await freshPlatform()
    const p = make()
    await expect(p.system.notify('one', 'body')).rejects.toThrow('not allowed for this page yet')
    await expect(p.system.notify('two', 'body')).resolves.toBeUndefined()
    // Another platform on the same page does not ask again
    const q = make()
    await expect(q.system.notify('three', 'body')).rejects.toThrow('not allowed for this page yet')
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(shown).toEqual([])
    await p.dispose()
    await q.dispose()
  })

  it('a notification asks for permission first, and says once when it is not allowed', async () => {
    const { shown, FakeNotification } = fakeNotifications('granted')
    const requestPermission = FakeNotification.requestPermission
    const p = (await freshPlatform())()
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
