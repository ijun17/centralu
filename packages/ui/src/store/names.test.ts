import { describe, expect, it } from 'vitest'
import { appTitleOf, machineNameOf, projectMachineOf } from './names.js'

describe('the names the screen shows (#2174)', () => {
  it('an app without a name shows its id', () => {
    expect(appTitleOf({ name: 'Notes', appId: 'notes' })).toBe('Notes')
    expect(appTitleOf({ name: null, appId: 'notes' })).toBe('notes')
    expect(appTitleOf({ appId: 'notes' })).toBe('notes')
  })

  it('a machine the list does not hold yet shows its id', () => {
    expect(machineNameOf({ m1: { name: 'Studio' } }, 'm1')).toBe('Studio')
    expect(machineNameOf({}, 'm1')).toBe('m1')
  })

  it('a project lives on this computer unless it names a machine', () => {
    const projects = { local: {}, away: { machine: 'm1' } }
    expect(projectMachineOf(projects, 'away')).toBe('m1')
    expect(projectMachineOf(projects, 'local')).toBeNull()
    expect(projectMachineOf(projects, 'gone')).toBeNull()
    expect(projectMachineOf(projects, null)).toBeNull()
  })
})
