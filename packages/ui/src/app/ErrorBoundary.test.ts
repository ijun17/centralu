import { describe, expect, it, vi } from 'vitest'
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from '../store/store.js'
import { ErrorBoundary } from './ErrorBoundary.jsx'

/** The boundary's side effect only: componentDidCatch is called as React calls it, with no DOM */
function caught(error: Error, componentStack: string) {
  const boundary = new ErrorBoundary({ children: null })
  boundary.componentDidCatch(error, { componentStack } as never)
}

describe('a crashed screen is told to the host', () => {
  it('sends the message, the stack and the component stack, and leaves the console line', () => {
    const platform = new MockPlatform()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    useStore.setState({ platform })
    const e = new Error('Maximum update depth exceeded')
    caught(e, '\n    at PeekLine')
    expect(platform.crashReports).toEqual([{ message: e.message, stack: e.stack, componentStack: '\n    at PeekLine' }])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('never throws: not before the app has a platform, not when the call rejects', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    useStore.setState({ platform: null })
    expect(() => caught(new Error('x'), '')).not.toThrow()
    const platform = new MockPlatform()
    platform.diagnostics.reportCrash = () => Promise.reject(new Error('host gone'))
    useStore.setState({ platform })
    expect(() => caught(new Error('x'), '')).not.toThrow()
    await Promise.resolve()
    log.mockRestore()
  })
})
