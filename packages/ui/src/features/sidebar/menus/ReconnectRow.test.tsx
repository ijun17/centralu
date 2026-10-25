import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineInfo } from '@cc/protocol'
import type { AppState } from '../../../store/store.js'

/*
 * Reconnect in a project's menu (#1533), drawn from a seeded machine row. renderToStaticMarkup reads a zustand store's
 * initial state, so `useStore` is replaced by one that reads `state` (as in SessionListRow.test.tsx). What a press does,
 * and what the row turns into, is the scenario in e2e/fixtures/sidebar-machines.ts.
 */
let state: Partial<AppState> = {}
vi.mock('../../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { ReconnectRow } = await import('./ReconnectRow.jsx')

beforeEach(() => {
  state = {}
})

function machine(over: Partial<MachineInfo> = {}): MachineInfo {
  return { id: 'box', name: 'Box', sshTarget: 'me@box', status: 'unreachable', error: null, operation: null, ...over } as unknown as MachineInfo
}

function render(m: MachineInfo | undefined) {
  state = { machines: m ? { box: m } : {} }
  return renderToStaticMarkup(<ReconnectRow machine="box" projectName="api" onClose={() => {}} />)
}

describe('Reconnect in a project menu', () => {
  it('is not there while the machine is connected, nor before its row has arrived', () => {
    expect(render(machine({ status: 'connected' }))).toBe('')
    expect(render(undefined)).toBe('')
  })

  it('is a Reconnect row at once for a machine that is away, with the same label as the badge menu', () => {
    for (const status of ['unreachable', 'away', 'refused', 'not_running'] as const) {
      const html = render(machine({ status }))
      expect(html).toContain('data-testid="reconnect-api"')
      expect(html).toContain('>Reconnect<')
      expect(html).not.toContain('disabled=""')
    }
  })

  it('says Connect for a machine the person disconnected, and Start where Centralu is stopped there', () => {
    expect(render(machine({ status: 'disconnected' }))).toContain('>Connect<')
    expect(render(machine({ status: 'stopped' }))).toContain('>Start<')
  })

  it('shows it is connecting, and cannot be pressed again, while an attempt is under way', () => {
    for (const status of ['connecting', 'starting', 'updating'] as const) {
      const html = render(machine({ status }))
      expect(html).toContain('Connecting…')
      expect(html).toContain('disabled=""')
    }
  })

  it('is not pressable while an install or update runs there, and says why', () => {
    const html = render(machine({ operation: { kind: 'update', step: 'installing' } as MachineInfo['operation'] }))
    expect(html).toContain('disabled=""')
    expect(html).toContain('Wait for the change under way there to finish')
  })
})
