import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The data folder tests run against (#368). A folder shared by every test file let one file's
 * session managers sweep away a handoff note another file had just written (ENOENT in CI,
 * run 37885918963). The guard is that each file is handed a fresh one: `mkdtemp` names it, so no
 * other file, and no other run on the machine, can be using it.
 */
describe('the data folder a test file runs against', () => {
  it('is a fresh temporary folder of its own, not one shared with other files', () => {
    const dir = process.env.CC_DATA_DIR!
    expect(dirname(dir)).toBe(tmpdir())
    expect(basename(dir)).toMatch(/^centralu-test-data-[A-Za-z0-9]{6}$/)
    expect(existsSync(dir)).toBe(true)
    // Nothing else has written into it: this file has not started a host or a manager
    expect(readdirSync(dir)).toEqual([])
  })
})
