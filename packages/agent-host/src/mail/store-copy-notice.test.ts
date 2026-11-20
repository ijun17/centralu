/**
 * The person is told when an update changed the store past what an older build reads without the copy kept before it
 * (#2304): one notice from Centralu at the start that ran the step, through the path the warnings take.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import { PERSON } from './address.js'
import { hostWorld } from './host-mail.test-helpers.js'

const worlds: ReturnType<typeof hostWorld>[] = []
afterEach(() => {
  for (const w of worlds.splice(0)) w.stop()
})

/** The host's mail started over a store whose open ran step 76 without a copy */
function started(store: Store): ReturnType<typeof hostWorld> {
  const w = hostWorld({ store })
  worlds.push(w)
  w.afterReady()
  return w
}

const notices = (store: Store) => store.mailbox.feedOf(PERSON, { limit: 50 }).filter((m) => m.facts.storeCopySkipped !== undefined)

describe('a store step that ran without a copy (#2304)', () => {
  it('a disk short of room: the person reads how much was free and how much a copy is made with, once', () => {
    const store = new Store()
    store.copySkipped = { step: 76, reason: 'low_disk', free: 1.5 * 2 ** 30, needed: 2.5 * 2 ** 30 }

    const w = started(store)
    // The mail of a host started again over the same store says nothing twice
    started(store)

    const told = notices(store)
    expect(told).toHaveLength(1)
    expect(told[0]?.body).toBe(
      "This update changed Centralu's data on this computer without keeping a copy first: the disk has 1.5 GB free, and the copy is made only when 2.5 GB is free (twice the size of the data). The change cannot be undone, and there is no copy to go back to. Centralu works as usual.",
    )
    expect(told[0]?.facts.storeCopySkipped).toEqual({ step: 76, reason: 'low_disk' })
    expect(told[0]?.dedupeKey).toBe('storecopy:76')
    // For the person only, and no session is woken for it
    expect(store.mailbox.recipients(told[0]?.id ?? '').map((r) => r.recipient)).toEqual([PERSON])
    expect(w.delivered).toEqual([])
  })

  it.each([
    { name: 'a byte short', short: 1 },
    { name: 'a megabyte short', short: 2 ** 20 },
    { name: 'a tenth of a gigabyte short', short: 0.1 * 2 ** 30 },
  ])('free space $name of the copy reads as just under it, never as the same figure twice', ({ short }) => {
    const store = new Store()
    const needed = 16 * 2 ** 30
    store.copySkipped = { step: 76, reason: 'low_disk', free: needed - short, needed }

    started(store)

    const body = notices(store)[0]?.body ?? ''
    // Each of these rounds to 16 GB, as the figure the copy needs does
    expect(body).toContain('the disk has just under 16 GB free, and the copy is made only when 16 GB is free')
  })

  it('a copy that could not be written: the person reads that, and the reason stays in the log', () => {
    const store = new Store()
    store.copySkipped = { step: 76, reason: 'failed' }

    started(store)

    expect(notices(store).map((m) => m.body)).toEqual([
      "This update changed Centralu's data on this computer without keeping a copy first: the copy could not be written. The change cannot be undone, and there is no copy to go back to. Centralu works as usual.",
    ])
  })
})
