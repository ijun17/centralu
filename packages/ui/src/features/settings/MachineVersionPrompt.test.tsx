import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MIN_SUPPORTED_VERSION } from '@cc/protocol/client'
import type { MachineInfo, MachineVersions } from '@cc/protocol'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'

/* #1143: the prompt of a link held at `versions_differ`, drawn from a seeded machine (as in MachineRowWait.test.tsx) */
vi.mock('../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store.js')>()
  const useStore = (selector: (s: unknown) => unknown) => selector(real.useStore.getState())
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const platform = { machines: { hubAuto: async () => null, askConsents: async () => [] } } as unknown as Platform

const { MachineRow } = await import('./MachinesSection.jsx')

function row(versions: Partial<MachineVersions>): string {
  const v: MachineVersions = {
    hub: { version: '0.1.0-beta.60', protocolVersion: 1, dev: false },
    remote: { version: '0.1.0-beta.44', protocolVersion: 1, dev: false },
    older: 'remote',
    compatible: false,
    sameChannel: true,
    accepted: false,
    ...versions,
  }
  const m = { id: 'box', name: 'Box', sshTarget: 'me@box', status: 'versions_differ', error: null, operation: null, versions: v } as unknown as MachineInfo
  return renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <MachineRow m={m} onOpenCategory={() => {}} />
    </PlatformProvider>,
  )
}

describe('the prompt of a link held on its versions', () => {
  it('says the oldest version this computer works with, for a remote below it on one protocol (#1143)', () => {
    const html = row({})
    expect(html).toContain(
      `Box runs Centralu 0.1.0-beta.44, older than ${MIN_SUPPORTED_VERSION}, the oldest this computer works with. They cannot connect until Box is updated.`,
    )
    expect(html).toContain(`Machines older than Centralu ${MIN_SUPPORTED_VERSION} cannot connect, even anyway.`)
    expect(html).not.toContain('protocol 1')
  })

  it('keeps the protocol sentences for two protocols', () => {
    const html = row({ remote: { version: '0.2.0-beta.1', protocolVersion: 2, dev: false }, older: 'hub' })
    expect(html).toContain('They cannot talk to each other until this computer is updated.')
    expect(html).toContain('Machines on different protocol versions cannot connect, even anyway.')
  })
})
