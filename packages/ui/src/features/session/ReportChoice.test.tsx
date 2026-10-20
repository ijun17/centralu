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

  it('shows the chosen one as checked, and only that one', () => {
    for (const c of CHOICES) {
      const html = render(c.value)
      expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
      expect(html).toMatch(new RegExp(`data-testid="report-choice-${c.value}"[^>]*>`))
      const checked = html.split('<button').filter((b) => b.includes('aria-checked="true"'))
      expect(checked[0]).toContain(`report-choice-${c.value}`)
    }
  })
})
