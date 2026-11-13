import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '@cc/protocol'
import type { HostMail } from '../mail/host-mail.js'
import { OWN_WORK_SETTLE_MS } from './child-ownership.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { addressOf, wireHostMail } from './host-mail.test-helpers.js'

/**
 * A session watch on a session whose turn ends while its own background work runs (#1324, docs/plans/mailbox.md §18.3), through a real manager: the
 * turn's end is not the session's rest, and the work's end with no turn after it is. Nobody gave the watched session work, so no open task asks for the
 * settle; the watch does.
 */

const verify: BackgroundTask = { id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }

describe('a watch on a session that pauses on its own background work', () => {
  let w: CrossWorld
  let m: HostMail
  let watcher: string
  let target: string
  beforeEach(async () => {
    w = await crossWorld()
    w.adapters.get('claude')!.capabilities.backgroundTasks = true
    watcher = await w.callerSession()
    target = await w.callerSession()
    m = wireHostMail(w.mgr, w.store)
    m.delivery.start()
  })
  afterEach(async () => {
    vi.useRealTimers()
    m.delivery.stop()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const fired = () =>
    w.store.mailbox
      .feedOf(addressOf(watcher), { limit: 50 })
      .filter((x) => x.facts.watch !== undefined)
      .map((x) => x.facts.reason)

  it('fires `turn_ended` once that work ended and no turn followed, not at the paused turn’s end', async () => {
    m.watches.register(addressOf(watcher), addressOf(target), '', (id) => id)
    await w.mgr.inputs.send(target, 'run the suite in the background')
    handleOf(target).event({ type: 'background_tasks', sessionId: target, live: [verify] })
    handleOf(target).answer('Started verify.')
    await w.until(() => w.mgr.sessionInfo(target)?.state !== 'working')
    expect(fired()).toEqual([])

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    handleOf(target).event({ type: 'background_tasks', sessionId: target, live: [], ended: [{ ...verify, status: 'completed' }] })
    await vi.advanceTimersByTimeAsync(OWN_WORK_SETTLE_MS + 1_000)
    vi.useRealTimers()
    await w.until(() => fired().length > 0)
    expect(fired()).toEqual(['turn_ended'])
  })
})
