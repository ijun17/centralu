import { describe, expect, it } from 'vitest'
import { USER_APP_SCOPE, appKeyOf, appLabel, parseAppKey } from './app-key.js'

describe('one app as a string', () => {
  it('a project app, a user-folder app and a linked machine\'s user-folder app each read back as themselves', () => {
    expect(appKeyOf('p1', 'notes')).toBe('p1/notes')
    expect(appKeyOf(null, 'notes')).toBe(`${USER_APP_SCOPE}/notes`)
    expect(appKeyOf(undefined, 'notes')).toBe('_user/notes')
    expect(appKeyOf(null, 'notes', 'm1')).toBe('m1:_user/notes')
    // A project already names its machine: the machine is ignored
    expect(appKeyOf('m1.p1', 'board', 'm1')).toBe('m1.p1/board')
    for (const [projectId, appId, machine] of [['p1', 'notes'], [null, 'notes'], [null, 'notes', 'm1']] as const) {
      const back = parseAppKey(appKeyOf(projectId, appId, machine))
      expect(back).toEqual({ projectId, appId, ...(machine ? { machine } : {}) })
    }
  })

  it('a label names the user folder or the start of the project id', () => {
    expect(appLabel({ projectId: null, appId: 'notes' })).toBe('user/notes')
    expect(appLabel({ projectId: '0123456789abcdef', appId: 'board' })).toBe('01234567/board')
  })
})
