import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, releaseOf } from '../packages/protocol/src/index.js'

describe('the protocol a published release declares (#689)', () => {
  // A hub running a local build installs the newest published release with its own protocol; the
  // registry knows a release's protocol only by this field
  it('the npm package states the protocol this source speaks', () => {
    const pkg = JSON.parse(readFileSync(new URL('../packaging/npm/centralu/package.json', import.meta.url), 'utf8')) as { protocolVersion?: number }
    expect(pkg.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('a local build is cut from its base release; any other version is itself', () => {
    expect(releaseOf('0.3.0-beta.7.local.2')).toBe('0.3.0-beta.7')
    expect(releaseOf('0.3.0-beta.7')).toBe('0.3.0-beta.7')
    expect(releaseOf('1.2.3-rc.1.local.10')).toBe('1.2.3-rc.1')
    expect(releaseOf('0.1.0.local.1')).toBe('0.1.0.local.1')
  })
})
