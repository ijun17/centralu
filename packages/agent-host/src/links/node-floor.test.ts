import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { belowFloor, floorOf, isHostCrash, switchedSentence, updateNodeSentence } from './node-floor.js'
import { nodeFloor } from './install.js'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { belowFloor as launcherBelowFloor, floorOf as launcherFloorOf } from '../../../../packaging/npm/centralu/bin/node-floor.mjs'

type FloorFixture = { floor: string; cases: { found: string; below: boolean }[] }

describe('the Node floor the hub checks machines against (#699)', () => {
  it('is the one the launcher checks: engines.node of the npm package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../../packaging/npm/centralu/package.json', import.meta.url), 'utf8')) as { engines: { node: string } }
    expect(nodeFloor()).toBe(floorOf(pkg.engines.node))
    expect(nodeFloor()).toBe(launcherFloorOf(pkg.engines.node))
    expect(nodeFloor()).toBe('22.14.0')
  })

  it('reads a version below it, and nothing it cannot read', () => {
    expect(belowFloor('22.12.0', '22.14.0')).toBe(true)
    expect(belowFloor('v22.13.1', '22.14.0')).toBe(true)
    expect(belowFloor('V22.13.1', '22.14.0')).toBe(true)
    expect(belowFloor('22.14.0', '22.14.0')).toBe(false)
    expect(belowFloor('24.21.0', '22.14.0')).toBe(false)
    expect(belowFloor(null, '22.14.0')).toBe(false)
    expect(belowFloor('unknown', '22.14.0')).toBe(false)
  })

  /*
   * The keeper checks the same floor in Rust (`host_proc/node.rs` `below_floor`) and disagreed on `v22.14.0-rc.1`,
   * `v22` and `v22.x.1`. One fixture pins the three checks; the keeper's test reads it too.
   */
  it('agrees with the launcher and the keeper on every version in the shared fixture', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../tooling/fixtures/node-floor.json', import.meta.url), 'utf8')) as FloorFixture
    expect(fixture.cases.length).toBeGreaterThan(10)
    for (const { found, below } of fixture.cases) {
      expect({ found, hub: belowFloor(found, fixture.floor) }).toEqual({ found, hub: below })
      expect({ found, launcher: launcherBelowFloor(found, fixture.floor) as boolean }).toEqual({ found, launcher: below })
    }
    const keeperTest = readFileSync(new URL('../../../../apps/desktop/src-tauri/keeper/src/host_proc/tests.rs', import.meta.url), 'utf8')
    expect(keeperTest).toContain('include_str!("../../../../../../tooling/fixtures/node-floor.json")')
  })

  it('knows the ways a host dies on a Node below it', () => {
    expect(isHostCrash('centralu serve exited (3221225477) before its host answered')).toBe(true)
    expect(isHostCrash('centralu serve exited (1) before its host answered:\nthe host exited (SIGSEGV)')).toBe(true)
    expect(isHostCrash('exit -1073741819')).toBe(true)
    expect(isHostCrash('centralu serve exited (1) before its host answered')).toBe(false)
    expect(isHostCrash('Port 17175 is in use')).toBe(false)
  })

  it('says in one sentence what it did, or why it did not and what to do', () => {
    const base = { name: 'Box', found: '22.12.0', floor: '22.14.0', kind: 'refused' as const }
    expect(switchedSentence({ ...base, node: '24.21.0' })).toBe(
      'Centralu installed its own Node 24.21.0 on Box, because the Node on Box (22.12.0) is older than 22.14.0, the oldest Centralu runs on.',
    )
    expect(updateNodeSentence({ ...base, reason: 'it runs a command of its own in place of centralu' })).toBe(
      'The Node on Box (22.12.0) is older than 22.14.0, the oldest Centralu runs on, and this computer did not install its own Node there (it runs a command of its own in place of centralu): update Node there, and Centralu starts again.',
    )
    // A crash under a Node it cannot name, or one at the floor or above, does not claim the Node is old
    expect(switchedSentence({ ...base, found: null, kind: 'crashed', node: '24.21.0' })).toBe(
      'Centralu installed its own Node 24.21.0 on Box, because Centralu crashed on start under the Node on Box, and 22.14.0 is the oldest Centralu runs on.',
    )
    expect(switchedSentence({ ...base, found: '22.15.0', kind: 'crashed', node: '24.21.0' })).toContain('crashed on start under the Node on Box (22.15.0)')
  })
})
