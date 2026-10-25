/**
 * An agent's "Apply now" with no card (#1509): the window the host picks waits out someone typing, as its own automatic
 * apply does. Ports go through `MockPlatform`; shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from './store.js'
import { resetStore } from './store.test-helpers.js'

const typing = vi.hoisted(() => ({ now: false }))
vi.mock('../features/settings/typing.js', async (importActual) => ({
  ...(await importActual<typeof import('../features/settings/typing.js')>()),
  typedWithin: () => typing.now,
}))

beforeEach(() => {
  resetStore()
  typing.now = false
})

async function goWith(requestId: string, unasked: boolean) {
  const platform = new MockPlatform()
  platform.relaunchCheck = { ready: true, version: '9999.0.0' }
  vi.spyOn(platform.updates, 'answerApply').mockResolvedValue({ ticket: `t-${requestId}` })
  const reports = vi.spyOn(platform.updates, 'reportApply')
  useStore.setState({
    platform,
    update: { current: '0.1.0', latest: '9999.0.0', newer: true, auto: true, autoApply: true, phase: 'restart_required', error: null, checkedAt: 1 },
  })
  useStore.getState().dispatchEvent({ type: 'update_apply_request', requestId })
  await vi.waitFor(() => expect(platform.updates.answerApply).toHaveBeenCalled())
  await vi.waitFor(async () => {
    // The ticket is kept once the answer settled
    await Promise.resolve()
  })
  useStore.getState().dispatchEvent({ type: 'update_apply_go', requestId, ticket: `t-${requestId}`, ...(unasked ? { unasked } : {}) })
  return { platform, reports }
}

describe('update_apply_go.unasked (#1509)', () => {
  it('relaunches an unasked go when nobody is typing', async () => {
    const { platform, reports } = await goWith('r1', true)
    await vi.waitFor(() => expect(platform.relaunches).toBe(1))
    expect(reports.mock.calls.some(([r]) => r.error)).toBe(false)
  })

  it('does not relaunch an unasked go while someone is typing, and says why', async () => {
    typing.now = true
    const { platform, reports } = await goWith('r2', true)
    await vi.waitFor(() => expect(reports).toHaveBeenCalledWith(expect.objectContaining({ ticket: 't-r2', error: expect.stringContaining('typing') })))
    expect(platform.relaunches).toBe(0)
  })

  it('relaunches a go the person allowed on a card even while they type', async () => {
    typing.now = true
    const { platform } = await goWith('r3', false)
    await vi.waitFor(() => expect(platform.relaunches).toBe(1))
  })
})
