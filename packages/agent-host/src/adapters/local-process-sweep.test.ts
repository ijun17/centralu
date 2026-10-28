import { describe, expect, it, vi } from 'vitest'
import type { GroupedChild } from '../dev-services/grouped-child.js'
import { realOs } from '../os/real.js'
import { spawnLocalAgent } from './local-process.js'

/**
 * The sweep after an agent CLI exits is given the exit time the host recorded (#1650 review): `sweepLeftovers` reads
 * what it left as what was created between its spawn and that exit, never up to the time of the sweep, by which Windows
 * may have given the pid to another program. `grouped-child.test.ts` holds the window; this holds that the caller hands
 * the recorded exit over, and does not stand in "now" for it.
 */
const swept: GroupedChild[] = []
vi.mock('../dev-services/grouped-child.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dev-services/grouped-child.js')>()),
  sweepLeftovers: async (started: GroupedChild) => {
    swept.push(started)
    return []
  },
}))

describe('an agent CLI that exits', () => {
  it('has what it left swept with the time of its exit, not the time of the sweep', async () => {
    const p = spawnLocalAgent({ command: realOs().env.execPath, args: ['-e', 'process.exit(0)'], env: process.env })
    await new Promise((resolve) => p.once('exit', resolve))
    await vi.waitFor(() => expect(swept).toHaveLength(1))
    const exitedAt = swept[0]!.exitedAt()
    expect(exitedAt).toBeTypeOf('number')
    await new Promise((resolve) => setTimeout(resolve, 40))
    // A recorded time does not move; "now" does
    expect(swept[0]!.exitedAt()).toBe(exitedAt)
  })
})
