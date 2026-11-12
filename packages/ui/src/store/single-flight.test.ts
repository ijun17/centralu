/**
 * The lists the host announces changes of (apps, mail, projects) are read one at a time through `coalescedRead` (#2172). A
 * read that finishes after `attach` swapped the platform writes nothing, and the new platform's ask is not handed the old
 * platform's read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, ProjectInfo } from '@cc/protocol/client'
// eslint-disable-next-line no-restricted-imports -- tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform, mockSessionParty } from '@cc/platform/mock'
import { useStore } from './store.js'
import { resetStore } from './store.test-helpers.js'

beforeEach(resetStore)

/** A promise a test settles by hand: the platform's answer arrives when the test says */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('a list read that finishes after the platform was swapped', () => {
  it('mail: the new platform is read, and the old answer is not written', async () => {
    const old = new MockPlatform()
    const next = new MockPlatform()
    const oldList = deferred<Awaited<ReturnType<MockPlatform['mail']['list']>>>()
    old.mail.list = () => oldList.promise
    const fresh = next.seedMail({ subject: 'New host', from: mockSessionParty('s1', 'Parser'), body: 'hi' })

    useStore.setState({ platform: old })
    void useStore.getState().loadMail()
    useStore.setState({ platform: next })
    await useStore.getState().loadMail()
    expect(useStore.getState().mail?.threads.map((t) => t.id)).toEqual([fresh])

    oldList.resolve({ threads: [], held: [], waiting: 9 })
    await new Promise((r) => setTimeout(r, 0))
    expect(useStore.getState().mail?.threads.map((t) => t.id)).toEqual([fresh])
  })

  it('apps: the old platform\'s list never lands over the new one\'s', async () => {
    const old = new MockPlatform()
    const next = new MockPlatform()
    const oldList = deferred<ExternalAppInfo[]>()
    old.apps.list = () => oldList.promise
    next.apps.list = async () => [{ appId: 'from-next', projectId: null } as unknown as ExternalAppInfo]

    useStore.setState({ platform: old })
    void useStore.getState().refreshExternalApps()
    useStore.setState({ platform: next })
    await useStore.getState().refreshExternalApps()
    expect(useStore.getState().externalApps.map((a) => a.appId)).toEqual(['from-next'])

    oldList.resolve([{ appId: 'from-old', projectId: null } as unknown as ExternalAppInfo])
    await new Promise((r) => setTimeout(r, 0))
    expect(useStore.getState().externalApps.map((a) => a.appId)).toEqual(['from-next'])
  })

  it('projects: the old platform\'s list never lands over the new one\'s', async () => {
    const old = new MockPlatform()
    const next = new MockPlatform()
    const oldList = deferred<ProjectInfo[]>()
    old.projects.list = () => oldList.promise
    const kept = await next.projects.add('/tmp/single-flight-next')

    useStore.setState({ platform: old })
    void useStore.getState().refreshProjects()
    useStore.setState({ platform: next })
    await useStore.getState().refreshProjects()
    expect(Object.keys(useStore.getState().projects)).toEqual([kept.id])

    oldList.resolve([{ ...kept, id: 'from-old' }])
    await new Promise((r) => setTimeout(r, 0))
    expect(Object.keys(useStore.getState().projects)).toEqual([kept.id])
  })
})

describe('asks that arrive during a read', () => {
  it('share one more read after it, not one each', async () => {
    const platform = new MockPlatform()
    const first = deferred<ExternalAppInfo[]>()
    const list = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([])
    platform.apps.list = list
    useStore.setState({ platform })

    const a = useStore.getState().refreshExternalApps()
    const b = useStore.getState().refreshExternalApps()
    const c = useStore.getState().refreshExternalApps()
    first.resolve([])
    await Promise.all([a, b, c])
    expect(list).toHaveBeenCalledTimes(2)
  })
})
