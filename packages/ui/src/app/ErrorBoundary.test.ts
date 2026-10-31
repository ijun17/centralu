import { describe, expect, it, vi } from 'vitest'
import { APP_VERSION } from '@cc/protocol/client'
import type { Platform } from '@cc/platform/ports'
import { useStore } from '../store/store.js'
import { ErrorBoundary, reportCrash } from './ErrorBoundary.jsx'

type Report = Parameters<Platform['diagnostics']['reportCrash']>[0]

/** The one port the boundary uses, recording what it is given */
function fakePlatform(call?: (r: Report) => Promise<void>) {
  const crashReports: Report[] = []
  const platform = { diagnostics: { reportCrash: (r: Report) => (crashReports.push(r), call ? call(r) : Promise.resolve()) } } as unknown as Platform
  return { platform, crashReports }
}

/** componentDidCatch as React calls it, with no DOM; the platform is the one App hands the boundary */
function caught(platform: Platform, error: unknown, componentStack: string) {
  const boundary = new ErrorBoundary({ children: null, platform })
  boundary.componentDidCatch(error as Error, { componentStack })
}

describe('a crashed screen is told to the host', () => {
  it('sends the message, stack, component stack and build, and leaves the console line', () => {
    const { platform, crashReports } = fakePlatform()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = new Error('Maximum update depth exceeded')
    caught(platform, e, '\n    at PeekLine')
    expect(crashReports).toEqual([{ message: e.message, stack: e.stack, componentStack: '\n    at PeekLine', version: APP_VERSION }])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('reports a crash in the first render, before the store has been given the platform', () => {
    const { platform, crashReports } = fakePlatform()
    useStore.setState({ platform: null })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    caught(platform, new Error('TopBar threw on load'), '\n    at TopBar')
    expect(crashReports.map((r) => r.message)).toEqual(['TopBar threw on load'])
    log.mockRestore()
  })

  it('cuts a field the host would refuse, and reports a thrown string by its text', () => {
    const { platform, crashReports } = fakePlatform()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const long = new Error('m'.repeat(50_000))
    long.stack = 's'.repeat(50_000)
    caught(platform, long, 'c'.repeat(50_000))
    caught(platform, 'x', '')
    const [a, b] = crashReports
    expect([a!.message.length, a!.stack.length, a!.componentStack.length]).toEqual([20_000, 20_000, 20_000])
    expect(b).toMatchObject({ message: 'x', stack: '' })
    log.mockRestore()
  })

  it('never throws: a platform without the call, a port that throws at once, a call that rejects', async () => {
    expect(() => reportCrash({} as Platform, new Error('x'), '')).not.toThrow()
    expect(() => reportCrash(null, new Error('x'), '')).not.toThrow()
    const sync = fakePlatform(() => {
      throw new Error('port broke')
    }).platform
    expect(() => reportCrash(sync, new Error('x'), '')).not.toThrow()
    const rejecting = fakePlatform(() => Promise.reject(new Error('host gone'))).platform
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    reportCrash(rejecting, new Error('x'), '')
    await new Promise((r) => setTimeout(r, 10))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
