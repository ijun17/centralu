import { describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol/client'
import { createMockPlatform } from './index.js'

/**
 * A linked machine's user-folder app is told from this computer's of the same id (#82): the port methods pass the machine, and the
 * mock finds the machine's row with it (a lookup without it matched nothing: "There is no such app").
 */
const row = (machine: string | null): ExternalAppInfo => ({
  appId: 'notes',
  projectId: null,
  name: machine ? 'Notes there' : 'Notes here',
  status: 'stopped',
  trusted: true,
  ...(machine ? { machine } : {}),
}) as ExternalAppInfo

describe('the mock finds a linked machine’s user-folder app by its machine', () => {
  it('restart, remove, setSecret and createBuilder reach the machine’s app, not this computer’s', async () => {
    const mock = createMockPlatform()
    try {
      mock.setExternalApps([row(null), row('m1')])
      await expect(mock.apps.restart('notes', null, 'm1')).resolves.toBeUndefined()
      // Found (it says what the app does not declare), not "no such app"
      await expect(mock.apps.setSecret('notes', null, 'TOKEN', 'x', 'm1')).rejects.toThrow(/does not declare/)
      await expect(mock.apps.createBuilder('notes', null, undefined, 'm1')).resolves.toMatchObject({ appId: 'notes' })
      // Naming no machine is this computer's app, which is there too
      await expect(mock.apps.restart('notes', null)).resolves.toBeUndefined()
      // An app of a machine that has none by that id is not there
      await expect(mock.apps.restart('notes', null, 'm2')).rejects.toThrow()
      await mock.apps.remove('notes', null, 'm1')
      expect(mock.removedApps).toEqual(['notes'])
      await expect(mock.apps.restart('notes', null, 'm1')).rejects.toThrow()
      await expect(mock.apps.restart('notes', null)).resolves.toBeUndefined()
    } finally {
      await mock.dispose()
    }
  })
})
