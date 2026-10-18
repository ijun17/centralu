import { beforeEach, describe, expect, it } from 'vitest'
import type { MachineInfo, ProjectInfo } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from '../../store/store.js'
import { resetStore } from '../../store/store.test-helpers.js'
import { neededKey } from './useMachineNeeds.js'

/**
 * Which machines the window says it needs (#1134): the machine of the focused session, of the focused project and of the
 * project the viewer shows, among those that connect when needed. The repeat while it stays so is the hook's, seen in
 * e2e/fixtures/machine-connect.ts.
 */

const machine = (id: string, connect: MachineInfo['connect']) => ({ id, connect }) as MachineInfo
const project = (id: string, machine: string | null) => ({ id, machine }) as ProjectInfo
type Shown = Parameters<typeof neededKey>[0]
const session = (id: string, projectId: string, machine: string | null) => ({ id, projectId, machine }) as unknown as Shown['sessions'][string]

const state = (o: { focusedSessionId?: string | null; focusedProjectId?: string | null; viewerProjectId?: string | null }): Shown => ({
  focusedSessionId: null,
  focusedProjectId: null,
  viewerProjectId: null,
  ...o,
  machines: { lap: machine('lap', 'when_needed'), box: machine('box', 'when_needed'), srv: machine('srv', 'at_start') },
  projects: { 'lap.p': project('lap.p', 'lap'), 'box.p': project('box.p', 'box'), 'srv.p': project('srv.p', 'srv'), here: project('here', null) },
  sessions: { 'lap.s': session('lap.s', 'lap.p', 'lap'), 'srv.s': session('srv.s', 'srv.p', 'srv') },
})

describe('the machines the window needs (#1134)', () => {
  beforeEach(() => resetStore())

  it('names a focused session’s machine and an open project’s, once each, when they connect when needed', () => {
    expect(neededKey(state({ focusedSessionId: 'lap.s' }))).toBe('lap')
    expect(neededKey(state({ focusedProjectId: 'box.p', viewerProjectId: 'lap.p' }))).toBe('box lap')
    expect(neededKey(state({ focusedSessionId: 'lap.s', focusedProjectId: 'lap.p' }))).toBe('lap')
  })

  it('names nothing for this computer or for a machine connected at start', () => {
    expect(neededKey(state({ focusedSessionId: 'srv.s', focusedProjectId: 'here' }))).toBe('')
    expect(neededKey(state({}))).toBe('')
  })

  it('says it to the host, and keeps quiet when the host does not take it', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.machinesList = [{ ...(await mock.machines.add({ name: 'Lap', sshTarget: 'me@lap', shell: 'posix' })), connect: 'when_needed', status: 'disconnected' }]
    await useStore.getState().needMachine('lap')
    expect(mock.machinesNeeded).toEqual(['lap'])
    expect(mock.machinesList[0]!.status).toBe('connected')

    mock.machines.need = async () => {
      throw new Error('Unknown method: machines.need')
    }
    await useStore.getState().needMachine('lap')
    expect(useStore.getState().toast).toBeFalsy()
  })
})
