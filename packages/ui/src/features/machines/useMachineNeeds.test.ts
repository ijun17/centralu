import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineInfo, ProjectInfo } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from '../../store/store.js'
import { resetStore } from '../../store/store.test-helpers.js'
import { NEED_REPEAT_MS, neededKey, sayNeeds } from './useMachineNeeds.js'

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

describe("the window's repeat (#1134 review M3)", () => {
  beforeEach(() => resetStore())
  afterEach(() => vi.useRealTimers())

  it('says a need at once, then again as a repeat while the set stays, and nothing once it changes', () => {
    vi.useFakeTimers()
    const said: string[] = []
    const stop = sayNeeds('box lap', (id, repeat) => said.push(`${id}${repeat ? ' again' : ''}`))
    expect(said).toEqual(['box', 'lap'])
    vi.advanceTimersByTime(NEED_REPEAT_MS)
    expect(said).toEqual(['box', 'lap', 'box again', 'lap again'])
    stop()
    vi.advanceTimersByTime(NEED_REPEAT_MS * 3)
    expect(said).toHaveLength(4)
    expect(sayNeeds('', () => said.push('x'))).toBeTypeOf('function')
    expect(said).toHaveLength(4)
  })

  it("a repeat does not bring back a machine the person disconnected; opening something of it again does", async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.machinesList = [{ ...(await mock.machines.add({ name: 'Lap', sshTarget: 'me@lap', shell: 'posix' })), connect: 'when_needed' }]
    await useStore.getState().disconnectMachine('lap')
    await useStore.getState().needMachine('lap', true)
    expect(mock.machinesList[0]!.status).toBe('disconnected')
    expect(mock.machinesNeeded).toEqual(['lap (again)'])
    await useStore.getState().needMachine('lap')
    expect(mock.machinesList[0]!.status).toBe('connected')
  })
})
