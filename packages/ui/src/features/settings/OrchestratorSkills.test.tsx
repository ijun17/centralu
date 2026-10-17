import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Platform } from '@cc/platform/ports'
import type { Load } from '../../app/useLoad.js'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'

/*
 * The approved skills under Settings → Orchestrator (#71). A static render runs no effect, so the read's outcome is
 * given through `useLoad`.
 */
let shown: Partial<Load<{ skills: { name: string; content: string }[] }>> = {}
vi.mock('../../app/useLoad.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/useLoad.js')>()),
  useLoad: () => ({ data: undefined, error: null, loading: false, reload: async () => {}, ...shown }),
}))

const { OrchestratorSkills } = await import('./Settings.jsx')
const platform = { agents: {} } as unknown as Platform
const render = () =>
  renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <OrchestratorSkills />
    </PlatformProvider>,
  )

describe('the approved skills', () => {
  it('shows nothing while there are none', () => {
    shown = { data: { skills: [] } }
    expect(render()).toBe('')
  })

  // #841: a failed read hid the section, which read as "no skills approved"
  it('says it could not read them instead of hiding the section', () => {
    shown = { error: 'RPC timed out' }
    const html = render()
    expect(html).toContain('data-testid="orchestrator-skills-failed"')
    expect(html).toContain('Could not read the approved skills: RPC timed out')
  })

  it('lists the ones it read', () => {
    shown = { data: { skills: [{ name: 'triage', content: 'Read the board first.' }] } }
    expect(render()).toContain('data-testid="orchestrator-skill-triage"')
  })
})
