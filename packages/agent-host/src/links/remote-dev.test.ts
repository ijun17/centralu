import { describe, expect, it } from 'vitest'
import { DATA_DIR_DEV } from '@cc/protocol'
import { hubDataDir } from './remote-dev.js'

/** `pnpm remote-dev` opens the hub's store to find the machine; it must read the folder the hub keeps its data in (#973) */
describe('the hub data folder pnpm remote-dev reads', () => {
  it('is the dev folder for a dev hub without CC_DATA_DIR, so the real data folder is not opened', () => {
    expect(hubDataDir({ CC_DEV: '1' }).split(/[\\/]/).pop()).toBe(DATA_DIR_DEV)
  })
})
