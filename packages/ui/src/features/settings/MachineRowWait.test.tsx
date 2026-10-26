import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineInfo } from '@cc/protocol'
import type { Platform } from '@cc/platform/ports'
import type { AppState } from '../../store/store.js'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'

/* #1579: the row of an update that waits, drawn from a seeded machine (the store is read as in ReconnectRow.test.tsx) */
let state: Partial<AppState> = {}
vi.mock('../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

// Only what the row's loaders ask of it; a static render runs none of them
const platform = { machines: { hubAuto: async () => null, askConsents: async () => [] } } as unknown as Platform

const { MachineRow } = await import('./MachinesSection.jsx')

beforeEach(() => {
  state = {}
})

function row(operation: MachineInfo['operation']): string {
  const m = { id: 'box', name: 'Box', sshTarget: 'me@box', status: 'connected', error: null, operation } as unknown as MachineInfo
  return renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <MachineRow m={m} onOpenCategory={() => {}} />
    </PlatformProvider>,
  )
}

describe('the row of an update that waits', () => {
  it('says what holds it and offers Cancel, also while only open terminals do', () => {
    const open = row({ kind: 'update', step: 'wait_open', target: '0.2.0', at: 1, count: 2 })
    expect(open).toContain('Updating to 0.2.0: waiting for 2 open terminals there (Update now closes them)…')
    expect(open).toContain('data-testid="machine-update-cancel-box"')
    const turns = row({ kind: 'update', step: 'wait_idle', target: '0.2.0', at: 1, count: 1 })
    expect(turns).toContain('waiting for 1 session in a turn…')
    expect(turns).toContain('data-testid="machine-update-cancel-box"')
  })

  it('offers no Cancel for a step that is not a wait', () => {
    expect(row({ kind: 'update', step: 'switch', target: '0.2.0', at: 1 })).not.toContain('machine-update-cancel-box')
  })
})
