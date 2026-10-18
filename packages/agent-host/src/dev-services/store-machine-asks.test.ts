import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'

/**
 * The reverse direction's switch and approved pairs (#550, store v60): stored with the machine and removed with it, and
 * with the project at the other end.
 */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function linked(store: Store, id = 'm1') {
  store.machines.addLinkedMachine({ id, name: 'Remote box', sshTarget: 'box', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
}

function withProject(): Store {
  const store = new Store()
  const d = mkdtempSync(join(tmpdir(), 'cc-machine-asks-'))
  dirs.push(d)
  store.projects.addProject({ id: 'p1', path: d, name: 'cc' })
  return store
}

const pair = { machineId: 'm1', sessionId: 's1', sessionName: 'worker', projectId: 'p1' }

describe('the switch for a machine’s sessions to ask this computer’s projects (#550)', () => {
  it('is off for a machine just linked, and is kept on its row', () => {
    const store = withProject()
    linked(store)
    expect(store.machines.linkedMachineAsks('m1')).toBe(false)
    expect(store.machines.listLinkedMachines()[0]).toMatchObject({ id: 'm1', asks: false })
    store.machines.setLinkedMachineAsks('m1', true)
    expect(store.machines.linkedMachineAsks('m1')).toBe(true)
    expect(store.machines.listLinkedMachines()[0]).toMatchObject({ asks: true })
    // A machine that is not linked never has it on
    expect(store.machines.linkedMachineAsks('m2')).toBe(false)
  })

  it('records an approved pair only while the switch is on and the project exists, and withdraws one', () => {
    const store = withProject()
    linked(store)
    expect(store.machines.setMachineAskConsent(pair)).toBe(false)
    store.machines.setLinkedMachineAsks('m1', true)
    expect(store.machines.setMachineAskConsent({ ...pair, projectId: 'gone' })).toBe(false)
    expect(store.machines.setMachineAskConsent(pair)).toBe(true)
    expect(store.machines.machineAskConsent('m1', 's1', 'p1')).toMatchObject(pair)
    expect(store.machines.machineAskConsent('m1', 's2', 'p1')).toBeNull()
    expect(store.machines.listMachineAskConsents('m1')).toEqual([expect.objectContaining(pair)])
    expect(store.machines.forgetMachineAskConsent('m1', 's1', 'p1')).toBe(true)
    expect(store.machines.forgetMachineAskConsent('m1', 's1', 'p1')).toBe(false)
    expect(store.machines.machineAskConsent('m1', 's1', 'p1')).toBeNull()
  })

  it('forgets the pairs when the switch goes off, so turning it on again approves nothing old', () => {
    const store = withProject()
    linked(store)
    store.machines.setLinkedMachineAsks('m1', true)
    store.machines.setMachineAskConsent(pair)
    store.machines.setLinkedMachineAsks('m1', false)
    store.machines.setLinkedMachineAsks('m1', true)
    expect(store.machines.listMachineAskConsents()).toEqual([])
  })

  it('goes with the machine, and a machine linked again under the same id starts with it off', () => {
    const store = withProject()
    linked(store)
    store.machines.setLinkedMachineAsks('m1', true)
    store.machines.setMachineAskConsent(pair)
    store.machines.removeLinkedMachine('m1')
    expect(store.machines.listMachineAskConsents()).toEqual([])
    linked(store)
    expect(store.machines.linkedMachineAsks('m1')).toBe(false)
  })

  it('goes with the machine when an older build removes it, and with the project at the other end', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-machine-asks-'))
    dirs.push(d)
    const file = join(d, 'store.db')
    const store = new Store(file)
    store.projects.addProject({ id: 'p1', path: join(d, 'p1'), name: 'cc' })
    store.projects.addProject({ id: 'p2', path: join(d, 'p2'), name: 'api' })
    linked(store)
    linked(store, 'm2')
    for (const m of ['m1', 'm2']) store.machines.setLinkedMachineAsks(m, true)
    store.machines.setMachineAskConsent(pair)
    store.machines.setMachineAskConsent({ ...pair, machineId: 'm2' })
    store.machines.setMachineAskConsent({ ...pair, machineId: 'm2', projectId: 'p2' })
    store.close()
    // What an older build's removal runs: the row alone, by a connection with foreign keys on (better-sqlite3's default)
    const db = new Database(file)
    db.pragma('foreign_keys = ON')
    db.prepare(`DELETE FROM linked_machines WHERE id = 'm1'`).run()
    db.prepare(`DELETE FROM projects WHERE id = 'p2'`).run()
    db.close()
    const again = new Store(file)
    expect(again.machines.listMachineAskConsents().map((c) => [c.machineId, c.projectId])).toEqual([['m2', 'p1']])
    again.close()
  })
})
