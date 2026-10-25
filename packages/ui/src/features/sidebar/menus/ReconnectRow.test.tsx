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
  return renderToStaticMarkup(<ReconnectRow machine="box" projectName="api" anchorEl={null} onClose={() => {}} />)
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

  it('shows it is connecting, and cannot be pressed again, while an attempt is under way; it stays focusable', () => {
    for (const status of ['connecting', 'starting', 'updating'] as const) {
      const html = render(machine({ status }))
      expect(html).toContain('Connecting…')
      expect(html).toContain('aria-disabled="true"')
      expect(html).not.toContain(' disabled=""')
    }
  })

  it('tells no result before the person has pressed it, whatever error the machine holds from before', () => {
    const html = render(machine({ status: 'refused', error: 'box@box: Permission denied (publickey).' }))
    expect(html).toContain('data-testid="reconnect-result-api"')
    expect(html).not.toContain('Could not connect')
    expect(html).not.toContain('ssh key')
  })

  it('puts its result in a live region that is not a status among the menu items, and describes the row by it only once it has one', () => {
    const html = render(machine({ status: 'refused', error: 'box@box: Permission denied (publickey).' }))
    // A menu holds menu items: an unnamed `status` between them is not one (#1543 review)
    expect(html).not.toContain('role="status"')
    expect(html).toMatch(/<div id="[^"]+" aria-live="polite"[^>]*data-testid="reconnect-result-api">/)
    // Nothing to describe the row by before a press has a result
    expect(html).not.toContain('aria-describedby')
  })

  it('is not pressable while an install or update runs there, and says why', () => {
    const html = render(machine({ operation: { kind: 'update', step: 'installing' } as MachineInfo['operation'] }))
    expect(html).toContain('disabled=""')
    expect(html).toContain('Wait for the change under way there to finish')
  })
})
