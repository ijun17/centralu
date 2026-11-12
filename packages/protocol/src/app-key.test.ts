import { describe, expect, it } from 'vitest'
import { USER_APP_SCOPE, appKeyOf, appLabel, parseAppKey, sameApp } from './app-key.js'

describe('one app as a string', () => {
  it("a project app, a user-folder app and a linked machine's user-folder app each read back as themselves", () => {
    expect(appKeyOf('p1', 'notes')).toBe('p1/notes')
    expect(appKeyOf(null, 'notes')).toBe(`${USER_APP_SCOPE}/notes`)
    expect(appKeyOf(undefined, 'notes')).toBe('_user/notes')
    expect(appKeyOf(null, 'notes', 'm1')).toBe('m1:_user/notes')
    // A project already names its machine: the machine is ignored
    expect(appKeyOf('m1.p1', 'board', 'm1')).toBe('m1.p1/board')
    for (const [projectId, appId, machine] of [
      ['p1', 'notes'],
      [null, 'notes'],
      [null, 'notes', 'm1'],
    ] as const) {
      const back = parseAppKey(appKeyOf(projectId, appId, machine))
      expect(back).toEqual({ projectId, appId, ...(machine ? { machine } : {}) })
    }
  })

  it('a reference is read as it is: the same key as its parts, with the machine of a user-folder app', () => {
    expect(appKeyOf({ projectId: 'p1', appId: 'notes' })).toBe(appKeyOf('p1', 'notes'))
    expect(appKeyOf({ projectId: null, appId: 'notes' })).toBe('_user/notes')
    expect(appKeyOf({ appId: 'notes' })).toBe('_user/notes')
    expect(appKeyOf({ projectId: null, appId: 'notes', machine: 'm1' })).toBe('m1:_user/notes')
    expect(appKeyOf({ projectId: 'm1.p1', appId: 'board', machine: 'm1' })).toBe('m1.p1/board')
  })

  it('two references are one app when both the project and the id agree', () => {
    expect(sameApp({ projectId: 'p1', appId: 'notes' }, { projectId: 'p1', appId: 'notes' })).toBe(true)
    expect(sameApp({ projectId: null, appId: 'notes' }, { projectId: null, appId: 'notes' })).toBe(true)
    expect(sameApp({ projectId: 'p1', appId: 'notes' }, { projectId: 'p2', appId: 'notes' })).toBe(false)
    expect(sameApp({ projectId: null, appId: 'notes' }, { projectId: 'p1', appId: 'notes' })).toBe(false)
    expect(sameApp({ projectId: 'p1', appId: 'notes' }, { projectId: 'p1', appId: 'board' })).toBe(false)
  })

  it("a user-folder app is also one per machine: absent and null are this computer's, a project's own id names its machine", () => {
    expect(sameApp({ projectId: null, appId: 'notes' }, { projectId: null, appId: 'notes', machine: null })).toBe(true)
    expect(sameApp({ appId: 'notes' }, { projectId: null, appId: 'notes', machine: undefined })).toBe(true)
    expect(sameApp({ projectId: null, appId: 'notes', machine: 'm1' }, { projectId: null, appId: 'notes', machine: 'm1' })).toBe(true)
    expect(sameApp({ projectId: null, appId: 'notes', machine: 'm1' }, { projectId: null, appId: 'notes' })).toBe(false)
    expect(sameApp({ projectId: null, appId: 'notes', machine: 'm1' }, { projectId: null, appId: 'notes', machine: 'm2' })).toBe(false)
    expect(sameApp({ projectId: 'm1.p1', appId: 'notes', machine: 'm1' }, { projectId: 'm1.p1', appId: 'notes' })).toBe(true)
  })

  it('a label names the user folder or the start of the project id', () => {
    expect(appLabel({ projectId: null, appId: 'notes' })).toBe('user/notes')
    expect(appLabel({ projectId: '0123456789abcdef', appId: 'board' })).toBe('01234567/board')
  })
})
