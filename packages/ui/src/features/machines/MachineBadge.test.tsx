import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MachineStatus, type MachineInfo, type ProjectInfo } from '@cc/protocol'
import { isAway } from '@cc/core'
import type { AppState } from '../../store/store.js'

/*
 * #1611: a project's machine badge, its dimming and its "Not connected" tooltip read one word, so a row is never dimmed
 * under a solid badge, nor a dashed badge left on a row that is not. renderToStaticMarkup reads a zustand store's initial
 * state, so `useStore` is replaced by one that reads `state` (as in ChatRow.test.tsx).
 */
let state: Partial<AppState> = {}
vi.mock('../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { MachineBadge } = await import('./MachineTag.jsx')
const { ProjectDetail } = await import('../sidebar/project/ProjectDetail.jsx')

beforeEach(() => {
  state = {}
})

const box = (status: MachineInfo['status']) => ({ id: 'box', name: 'Box', sshTarget: 'me@box', status, error: null }) as MachineInfo
const project = (unreachable: boolean) => ({ id: 'box.p1', name: 'api', path: '/srv/api', machine: 'box', unreachable, git: null }) as unknown as ProjectInfo

/** What a person sees of one project row: whether its badge is dashed, whether the row is dimmed, whether its tooltip says it is not connected */
function seen(machine: MachineInfo | undefined, unreachable: boolean) {
  const row = project(unreachable)
  state = { machines: machine ? { box: machine } : {}, projects: { [row.id]: row } }
  const badge = renderToStaticMarkup(<MachineBadge machine="box" testId="badge" />)
  const detail = renderToStaticMarkup(<ProjectDetail project={row} />)
  // ProjectBlock dims the section by this very call
  const dimmed = isAway(row, state.machines!)
  return { dashed: badge.includes('border-dashed'), dimmed, toldNotConnected: detail.includes('Not connected to') }
}

describe('the badge, the dimming and the tooltip of a project on a linked machine (#1611)', () => {
  const states: (MachineInfo['status'] | undefined)[] = [undefined, ...MachineStatus.options]

  it('agree in every state of the machine, whether or not the row carries the hub’s mirror mark', () => {
    for (const status of states) {
      for (const mark of [false, true]) {
        const { dashed, dimmed, toldNotConnected } = seen(status ? box(status) : undefined, mark)
        const where = `machine ${status ?? 'with no row'}, row marked ${mark}`
        expect(dimmed, where).toBe(dashed)
        expect(toldNotConnected, where).toBe(dashed)
        // Dashed is exactly: a machine whose row says it is not connected
        expect(dashed, where).toBe(status !== undefined && status !== 'connected')
      }
    }
  })

  it('a connected machine is solid under a row that carries the hub’s mirror mark, and the row is not dimmed', () => {
    expect(seen(box('connected'), true)).toEqual({ dashed: false, dimmed: false, toldNotConnected: false })
  })
})
