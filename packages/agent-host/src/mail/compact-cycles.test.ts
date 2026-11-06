import { afterEach, describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { at, hostWorld } from './host-mail.test-helpers.js'
import { HOUR_MS } from './rules.js'

/**
 * The warning about a session that keeps compacting and going on (#2024): it is the mailbox's own warning to the person (#2014, D32), written
 * through `MessageService.notice`, once per session per clock hour, and it wakes no one and holds nothing.
 */

let world: ReturnType<typeof hostWorld>
afterEach(() => world.stop())

const warnings = () => world.store.mailbox.feedOf(PERSON, { limit: 50 }).filter((m) => m.facts.compactCycles !== undefined)

describe('compact cycles warning (#2024)', () => {
  it('writes the person one notice naming the session and the count, and one only in a clock hour', () => {
    world = hostWorld()
    world.hooks.compactCycles?.('a', 7)
    world.hooks.compactCycles?.('a', 8)
    const told = warnings()
    expect(told).toHaveLength(1)
    expect(told[0]?.facts.compactCycles).toEqual({ session: at('a'), count: 7 })
    expect(told[0]?.body).toBe('alpha compacted its conversation and went on to its next step 7 times in the last hour. It keeps working: look at it if that is more than you expect.')
    expect(told[0]?.dedupeKey).toBe(`compactcycles:${at('a')}:${Math.floor(world.clock.t / HOUR_MS) * HOUR_MS}`)
    // For the person only, and no session is woken for it
    expect(world.store.mailbox.recipients(told[0]?.id ?? '').map((r) => r.recipient)).toEqual([PERSON])
    expect(world.delivered).toEqual([])
    // Another session has its own line, and the next hour its own again
    world.hooks.compactCycles?.('b', 9)
    expect(warnings()).toHaveLength(2)
    world.clock.t += HOUR_MS
    world.hooks.compactCycles?.('a', 10)
    expect(warnings()).toHaveLength(3)
  })
})
