import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHOICES, ReportChoice } from './ReportChoice.jsx'

/**
 * "Working for <caller>" (#1377): the three things a message can mean to a report the session owes. What each does is the
 * host's rule (paused-reports.test.ts); this is what the person is shown.
 */
describe('the choice the composer offers for a session that owes a report', () => {
  const render = (value: 'ask' | 'task' | 'takeover') =>
    renderToStaticMarkup(<ReportChoice owed={{ callerId: 'o1', callerName: 'Orchestrator' }} value={value} onChange={() => {}} />)

  it('names who waits for the work, and offers the three choices in order', () => {
    const html = render('ask')
    expect(html).toContain('Working for')
    expect(html).toContain('Orchestrator')
    expect(CHOICES.map((c) => c.label)).toEqual(['Just asking', 'Add to the task', 'Take it over'])
    expect(CHOICES.map((c) => c.value)).toEqual(['ask', 'task', 'takeover'])
    for (const c of CHOICES) expect(html).toContain(c.label)
  })

  it('shows the chosen one as pressed, and only that one', () => {
    for (const c of CHOICES) {
      const html = render(c.value)
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
      const pressed = html.split('<button').filter((b) => b.includes('aria-pressed="true"'))
      expect(pressed[0]).toContain(`report-choice-${c.value}`)
      // The hint of the chosen one is shown, not only a tooltip
      expect(html).toContain(c.hint)
    }
  })
})
