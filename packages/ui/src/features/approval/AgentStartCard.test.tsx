import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalDetail } from '@cc/protocol'
import type { Platform } from '@cc/platform/ports'
import type { AppState } from '../../store/store.js'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'

/*
 * start_agent's card (#561) drawn as the session shows it. renderToStaticMarkup reads a zustand store's initial state,
 * so `useStore` is replaced by one that reads `state` (as in RowApproval.test.tsx).
 */
let state: Partial<AppState> = {}
vi.mock('../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { ApprovalCard } = await import('./ApprovalCard.jsx')

const platform = { capabilities: { shortcutKeys: { mod: '⌘', alt: '⌥' } } } as unknown as Platform

beforeEach(() => {
  state = { approvalsInFlight: {} }
})

function render(detail: ApprovalDetail): { html: string; text: string } {
  const html = renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <ApprovalCard sessionId="s1" requestId="ag-1" detail={detail} />
    </PlatformProvider>,
  )
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim() }
}

const here: Extract<ApprovalDetail, { kind: 'agent_start' }> = { kind: 'agent_start', project: { id: 'p', name: 'site' }, tool: 'Codex', preset: 'normal', text: 'write the parser' }

describe('the start-agent card', () => {
  it('offers always for the session and the project for a child on this computer', () => {
    const { html } = render(here)
    expect(html).toContain('data-testid="approve-always"')
    expect(html).toContain('data-testid="approve-always-project"')
  })

  // #1038: nothing is remembered for another machine's project, as ask_project's card to one (#700)
  it('names the machine of a child started on one, and offers only allow once and deny', () => {
    const { html, text } = render({ ...here, machine: 'Windows PC' })
    expect(text).toContain('Start Codex in "site" on "Windows PC", with normal permissions, to write the parser?')
    expect(text).toContain('It opens on Windows PC')
    expect(html).toContain('data-testid="approve-allow"')
    expect(html).toContain('data-testid="approve-deny"')
    expect(html).not.toContain('data-testid="approve-always"')
    expect(html).not.toContain('data-testid="approve-always-project"')
  })
})
